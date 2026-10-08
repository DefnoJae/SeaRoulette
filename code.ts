function init() {
    $ui.register((ctx) => {
        const LISTS = [
            ["CURRENT", "Watching"], ["PLANNING", "Planning"], ["PAUSED", "Paused"],
            ["COMPLETED", "Completed"], ["DROPPED", "Dropped"], ["REPEATING", "Repeating"],
        ];
        const GENRES = ["Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"];
        type Settings = {
            lists: string[];
            dubOnly: boolean;
            minRating: number;
            maxRating: number;
            genres: string[];
            genreMode: "ANY" | "ALL";
            tasteEnabled: boolean;
            tasteSeeds: Array<{
                id: number;
                title: string;
            }>;
        };
        let settings: Settings = loadSettings();
        let cooldownUntil = 0;
        let used: number[] = [];
        let cachedPool: any[] = [];
        let cacheKey = "";
        let lastPick = "";
        let tasteQuery = "";
        const tasteQueryRef = ctx.fieldRef("");
        let tasteResults: any[] = [];
        let collectionCache: any = null;
        let generating = false;
        let revision = 0;
        let lastRequestAt = -Infinity;
        let requestQueue: Promise<void> = Promise.resolve();
        let lastRefreshAt = -Infinity;
        const metadata: Record<string, any> = {};
        const DUB_URL = "https://raw.githubusercontent.com/MAL-Dubs/MAL-Dubs/main/data/dubInfo.json";
        let dubCatalog: any = $storage.get("dubCatalog");
        let rateLimitedUntil = 0;
        function validCatalog(value: any): boolean {
            return !!value && Array.isArray(value.dubbed) && value.dubbed.length > 0 &&
                value.dubbed.every((id: any) => Number.isInteger(id) && id > 0) &&
                Array.isArray(value.incomplete) && value.incomplete.every((id: any) => Number.isInteger(id) && id > 0);
        }
        async function loadDubCatalog() {
            if (validCatalog(dubCatalog) && Number.isFinite(dubCatalog.fetchedAt) && Date.now() - dubCatalog.fetchedAt < 24 * 60 * 60 * 1000)
                return;
            try {
                const response = await ctx.fetch(DUB_URL, { timeout: 15, noCloudflareBypass: true });
                if (!response.ok)
                    throw new Error("Dub catalog HTTP " + response.status);
                const data = response.json();
                if (!validCatalog(data))
                    throw new Error("Invalid dub catalog");
                dubCatalog = { dubbed: data.dubbed, incomplete: data.incomplete, fetchedAt: Date.now() };
                $storage.set("dubCatalog", dubCatalog);
            }
            catch (error) {
                if (!validCatalog(dubCatalog) || !Number.isFinite(dubCatalog.fetchedAt) || Date.now() - dubCatalog.fetchedAt >= 7 * 24 * 60 * 60 * 1000)
                    throw error;
                ctx.toast.info("SeaRoulette: using the saved dub catalog while its source is unavailable.");
            }
        }
        const tray = ctx.newTray({
            withContent: true,
            width: "430px",
            iconUrl: "https://seanime.app/logo_2.png",
        });
        function loadSettings(): Settings {
            const saved = $storage.get("settings") as any;
            return {
                lists: Array.isArray(saved?.lists) ? saved.lists.filter((s: any) => LISTS.some(x => x[0] === s)) : ["PLANNING"],
                dubOnly: !!saved?.dubOnly,
                minRating: ratingValue(saved?.minRating, 0),
                maxRating: ratingValue(saved?.maxRating, 100),
                genres: Array.isArray(saved?.genres) ? saved.genres.filter((g: any) => GENRES.indexOf(g) >= 0) : [],
                genreMode: saved?.genreMode === "ALL" ? "ALL" : "ANY",
                tasteEnabled: !!saved?.tasteEnabled,
                tasteSeeds: Array.isArray(saved?.tasteSeeds) ? saved.tasteSeeds.filter((s: any, i: number, a: any[]) => Number.isInteger(s?.id) && s.id > 0 && a.findIndex(x => x?.id === s.id) === i).slice(0, 5).map((s: any) => ({ id: s.id, title: String(s.title || "Untitled") })) : [],
            };
        }
        function save() { $storage.set("settings", settings); }
        function ratingValue(value: any, fallback: number): number {
            const n = Number(value ?? fallback);
            return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback;
        }
        // Public HTTP GraphQL responses wrap metadata in the data property.
        function query(query: string, variables: Record<string, any>, expectedRevision = revision): Promise<any> {
            // Direct public HTTP requests have no hidden AniList retry loop.
            const request = requestQueue.then(async () => {
                if (Date.now() < rateLimitedUntil)
                    throw new Error("AniList rate limited. Wait " + Math.ceil((rateLimitedUntil - Date.now()) / 1000) + "s, then try again.");
                const delay = Math.max(0, lastRequestAt + 2500 - Date.now());
                if (delay)
                    await new Promise<void>(resolve => ctx.setTimeout(resolve, delay));
                if (expectedRevision !== revision)
                    throw new Error("Filters changed");
                lastRequestAt = Date.now();
                const response = await ctx.fetch("https://graphql.anilist.co", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ query, variables }), timeout: 15, noCloudflareBypass: true,
                });
                if (response.status === 429) {
                    const retryHeader = Object.keys(response.headers).find(key => key.toLowerCase() === "retry-after");
                    const wait = Number(retryHeader ? response.headers[retryHeader] : "60");
                    rateLimitedUntil = Date.now() + (Number.isFinite(wait) ? Math.max(1, wait) : 60) * 1000;
                    throw new Error("AniList rate limited. No automatic retry; wait before trying again.");
                }
                if (!response.ok)
                    throw new Error("AniList HTTP " + response.status);
                const result = response.json();
                if (result?.errors?.length)
                    throw new Error(String(result.errors[0].message || "AniList query failed"));
                if (!result?.data)
                    throw new Error("AniList returned no data");
                return result.data;
            });
            requestQueue = request.then(() => undefined, () => undefined);
            return request;
        }
        function titleOf(m: any) { return String(m?.title?.userPreferred || m?.title?.english || m?.title?.romaji || "Untitled"); }
        function reportError(action: string, error: any) {
            const detail = String(error?.message || error || "Unknown error");
            console.error("SeaRoulette: " + action + " failed: " + detail);
            ctx.toast.error("SeaRoulette: " + action + " failed: " + detail.slice(0, 220));
        }
        function setArrayValue(arr: string[], value: string, on: boolean) {
            const exists = arr.indexOf(value) >= 0;
            if (on && !exists)
                arr.push(value);
            if (!on && exists)
                arr.splice(arr.indexOf(value), 1);
            invalidate();
        }
        function invalidate(resetPool = true) {
            revision++;
            if (resetPool) {
                cachedPool = [];
                cacheKey = "";
                used = [];
            }
            save();
            tray.update();
        }
        function flattenCollection(): any[] {
            if (!collectionCache)
                collectionCache = $anilist.getAnimeCollection(false);
            const lists = collectionCache?.MediaListCollection?.lists;
            if (!Array.isArray(lists))
                throw new Error("Could not read your AniList collection");
            const out: any[] = [];
            const seen: Record<string, boolean> = {};
            for (const list of lists) {
                for (const entry of (list?.entries || [])) {
                    if (settings.lists.indexOf(String(entry?.status || list?.status || "")) < 0)
                        continue;
                    const media = entry?.media;
                    if (!media?.id || seen[String(media.id)])
                        continue;
                    seen[String(media.id)] = true;
                    out.push(media);
                }
            }
            return out;
        }
        function passesBasic(m: any): boolean {
            const rating = Number(m?.meanScore || 0);
            if (settings.minRating > 0 && rating < settings.minRating)
                return false;
            if (settings.maxRating < 100 && rating > settings.maxRating)
                return false;
            if (settings.genres.length) {
                const mg = (m?.genres || []).map(String);
                const hits = settings.genres.filter(g => mg.indexOf(g) >= 0).length;
                if (settings.genreMode === "ALL" ? hits !== settings.genres.length : hits === 0)
                    return false;
            }
            return true;
        }
        function hasEnglishDub(media: any): boolean {
            const malId = Number(media.idMal);
            return malId > 0 && (dubCatalog.dubbed.indexOf(malId) >= 0 || dubCatalog.incomplete.indexOf(malId) >= 0);
        }
        function buildPool(): any[] {
            const key = JSON.stringify([settings.lists, settings.dubOnly, settings.minRating, settings.maxRating, settings.genres, settings.genreMode]);
            if (key === cacheKey)
                return cachedPool;
            let pool = flattenCollection().filter(passesBasic);
            cachedPool = pool;
            cacheKey = key;
            used = [];
            return pool;
        }
        function tasteScore(m: any): number {
            if (!settings.tasteEnabled || !settings.tasteSeeds.length)
                return 1;
            let score = 0;
            const candidateGenres = (m?.genres || []).map(String);
            for (const seed of settings.tasteSeeds) {
                const d: any = metadata[String(seed.id)];
                const sg = (d?.genres || []).map(String);
                const overlap = sg.filter((g: string) => candidateGenres.indexOf(g) >= 0).length;
                score += overlap * 12;
                const candidateTags = metadata[String(m.id)]?.tags || [];
                for (const tag of (d?.tags || [])) {
                    const match = candidateTags.find((t: any) => t.id === tag.id);
                    if (match)
                        score += 20 * Math.min(Number(tag.rank || 0), Number(match.rank || 0)) / 100;
                }
                const recs = d?.recommendations?.edges || [];
                if (recs.some((e: any) => Number(e?.node?.mediaRecommendation?.id) === Number(m.id)))
                    score += 55;
            }
            return Math.max(1, score);
        }
        async function prepareTaste(pool: any[], expectedRevision: number) {
            if (!settings.tasteEnabled || !settings.tasteSeeds.length)
                return;
            // Fetch recommendation connections only for the 1–5 taste seeds.
            const seeds = settings.tasteSeeds.map(s => s.id).filter(id => !metadata[String(id)]?.recommendations);
            if (seeds.length) {
                const data = await query(`query($ids:[Int]){Page(page:1,perPage:5){media(id_in:$ids,type:ANIME){id genres tags{id rank} recommendations(perPage:25,sort:RATING_DESC){edges{node{mediaRecommendation{id}}}}}}}`, { ids: seeds }, expectedRevision);
                if (!Array.isArray(data?.Page?.media) || data.Page.media.length !== seeds.length)
                    throw new Error("Could not load taste seeds");
                for (const media of data.Page.media)
                    metadata[String(media.id)] = media;
            }
            const ids = pool.map(m => Number(m.id)).concat(settings.tasteSeeds.map(s => s.id))
                .filter((id, i, a) => a.indexOf(id) === i && !metadata[String(id)]);
            for (let i = 0; i < ids.length; i += 50) {
                const batch = ids.slice(i, i + 50);
                const data = await query(`query($ids:[Int]){Page(page:1,perPage:50){media(id_in:$ids,type:ANIME){id genres tags{id rank}}}}`, { ids: batch }, expectedRevision);
                if (!Array.isArray(data?.Page?.media) || data.Page.media.length !== batch.length)
                    throw new Error("Could not load taste metadata");
                for (const media of data.Page.media)
                    metadata[String(media.id)] = media;
            }
        }
        function choose(pool: any[]): any {
            let available = pool.filter((m: any) => used.indexOf(Number(m.id)) < 0);
            if (!available.length) {
                used = [];
                available = pool.slice();
            }
            if (!settings.tasteEnabled || !settings.tasteSeeds.length) {
                return available[Math.floor(Math.random() * available.length)];
            }
            const weighted = available.map((m: any) => ({ m, w: tasteScore(m) }));
            const total = weighted.reduce((s: number, x: any) => s + x.w, 0);
            let roll = Math.random() * total;
            for (const x of weighted) {
                roll -= x.w;
                if (roll <= 0)
                    return x.m;
            }
            return weighted[weighted.length - 1]?.m;
        }
        async function generate() {
            if (generating)
                return;
            const left = cooldownUntil - Date.now();
            if (left > 0) {
                ctx.toast.warning("SeaRoulette: wait " + Math.ceil(left / 1000) + "s before spinning again.");
                return;
            }
            if (!settings.lists.length) {
                ctx.toast.warning("SeaRoulette: select at least one AniList list.");
                return;
            }
            if (settings.minRating > settings.maxRating) {
                ctx.toast.warning("SeaRoulette: minimum rating must not exceed maximum rating.");
                return;
            }
            if (settings.tasteEnabled && !settings.tasteSeeds.length) {
                ctx.toast.warning("SeaRoulette: choose 1–5 taste anime first.");
                return;
            }
            generating = true;
            tray.update();
            let stage = "AniList collection loading";
            const generationRevision = revision;
            try {
                let pool = buildPool();
                if (settings.dubOnly) {
                    stage = "English dub catalog loading";
                    await loadDubCatalog();
                    if (generationRevision !== revision)
                        return;
                    pool = pool.filter(hasEnglishDub);
                }
                if (!pool.length) {
                    ctx.toast.warning("SeaRoulette: no anime matched these filters.");
                    return;
                }
                stage = "Taste metadata loading";
                if (settings.tasteEnabled)
                    await prepareTaste(pool, generationRevision);
                if (generationRevision !== revision)
                    return;
                stage = "Anime selection";
                const pick = choose(pool);
                if (!pick)
                    return;
                used.push(Number(pick.id));
                lastPick = titleOf(pick);
                cooldownUntil = Date.now() + 5000;
                tray.update();
                stage = "Opening anime page";
                ctx.screen.navigateTo("/entry", { id: String(pick.id) });
                ctx.toast.success("SeaRoulette picked " + lastPick);
                function tick() {
                    tray.update();
                    if (Date.now() < cooldownUntil)
                        ctx.setTimeout(tick, Math.min(1000, cooldownUntil - Date.now()));
                }
                ctx.setTimeout(tick, 1000);
            }
            catch (error) {
                if (generationRevision === revision)
                    reportError(stage, error);
            }
            finally {
                generating = false;
                tray.update();
            }
        }
        let searching = false;
        async function searchTaste() {
            if (searching)
                return;
            const q = tasteQuery.trim();
            if (!q) {
                tasteResults = [];
                tray.update();
                return;
            }
            searching = true;
            tray.update();
            const searchRevision = revision;
            try {
                // Use GraphQL explicitly: v3.10.3 listAnime's runtime has an extra tags
                // argument missing from its declaration file.
                const r = await query(`query($search:String!){Page(page:1,perPage:8){media(search:$search,type:ANIME){id title{english romaji userPreferred}}}}`, { search: q }, searchRevision);
                if (tasteQuery.trim() !== q || searchRevision !== revision)
                    return;
                if (!Array.isArray(r?.Page?.media))
                    throw new Error("Invalid search response");
                tasteResults = r.Page.media;
            }
            catch (e) {
                tasteResults = [];
                if (searchRevision === revision)
                    reportError("Taste search", e);
            }
            finally {
                searching = false;
                tray.update();
            }
        }
        ctx.registerEventHandler("generate", generate);
        ctx.registerEventHandler("refresh-pool", () => {
            if (generating || searching)
                return;
            if (Date.now() - lastRefreshAt < 60000) {
                ctx.toast.info("SeaRoulette: the collection was refreshed recently. Try Generate.");
                return;
            }
            lastRefreshAt = Date.now();
            try {
                collectionCache = $anilist.getAnimeCollection(true);
                // Keep expensive metadata and valid dub evidence on refresh.
                invalidate();
                ctx.toast.success("SeaRoulette pool refreshed.");
            }
            catch (error) {
                reportError("Collection refresh", error);
            }
        });
        ctx.registerEventHandler("min-rating", (e: any) => { settings.minRating = ratingValue(e?.value, settings.minRating); invalidate(); });
        ctx.registerEventHandler("max-rating", (e: any) => { settings.maxRating = ratingValue(e?.value, settings.maxRating); invalidate(); });
        ctx.registerEventHandler("genre-mode", (e: any) => { settings.genreMode = String(e?.value ?? e) === "ALL" ? "ALL" : "ANY"; invalidate(); });
        ctx.registerEventHandler("taste-query", (e: any) => { tasteQuery = String(e?.value ?? e ?? ""); });
        ctx.registerEventHandler("taste-search", searchTaste);
        for (const item of LISTS)
            ctx.registerEventHandler("list-" + item[0], (e: any) => setArrayValue(settings.lists, item[0], typeof e?.value === "boolean" ? e.value : settings.lists.indexOf(item[0]) < 0));
        for (const g of GENRES)
            ctx.registerEventHandler("genre-" + g, (e: any) => setArrayValue(settings.genres, g, typeof e?.value === "boolean" ? e.value : settings.genres.indexOf(g) < 0));
        ctx.registerEventHandler("genre-mode-any", () => {settings.genreMode="ANY";invalidate();});
        ctx.registerEventHandler("genre-mode-all", () => {settings.genreMode="ALL";invalidate();});
        ctx.registerEventHandler("dub-only", (e: any) => { settings.dubOnly = !!(e?.value ?? e); invalidate(); });
        ctx.registerEventHandler("taste-enabled", (e: any) => { settings.tasteEnabled = !!e?.value; invalidate(false); });
        for (let i = 0; i < 8; i++)
            ctx.registerEventHandler("taste-result-" + i, () => {
                const m = tasteResults[i];
                if (!m)
                    return;
                if (settings.tasteSeeds.some(x => Number(x.id) === Number(m.id)))
                    return;
                if (settings.tasteSeeds.length >= 5) {
                    ctx.toast.warning("SeaRoulette: taste filter supports at most 5 anime.");
                    return;
                }
                settings.tasteSeeds.push({ id: Number(m.id), title: titleOf(m) });
                tasteResults = [];
                tasteQuery = "";
                tasteQueryRef.setValue("");
                invalidate(false);
            });
        for (let i = 0; i < 5; i++)
            ctx.registerEventHandler("remove-seed-" + i, () => { settings.tasteSeeds.splice(i, 1); invalidate(false); });
        tray.render(() => {
            const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
            const items: any[] = [
                tray.text({
                    text: "SeaRoulette 0.1.6",
                    style: { fontSize: "20px", fontWeight: "700" }
                }),
                tray.button({
                    label: generating ? "Finding an anime…" : seconds ? "Spin again in " + seconds + "s" : "🎲 Generate",
                    onClick: "generate", intent: "primary", disabled: seconds > 0 || generating, loading: generating, size: "lg"
                }),
                ...(lastPick ? [tray.text({
                        text: "Last pick: " + lastPick,
                        style: { opacity: "0.7", fontSize: "12px" }
                    })] : []),
                tray.dropdownMenu({
                    trigger: tray.button({label:"Lists · " + (settings.lists.length === 1 ? LISTS.find(x=>x[0]===settings.lists[0])?.[1] : settings.lists.length + " selected") + " ▾",size:"sm"}),
                    items: LISTS.map(x=>tray.dropdownMenuItem({item:tray.text({text:(settings.lists.indexOf(x[0])>=0?"✓ ":"＋ ")+x[1]}),onClick:"list-"+x[0]})),
                }),
                tray.dropdownMenu({
                    trigger:tray.button({label:"Genres · " + (settings.genres.length ? settings.genres.length + " selected · " + settings.genreMode : "Any") + " ▾",size:"sm"}),
                    className:"max-h-[300px] overflow-y-auto",
                    items:[
                        ...GENRES.map(g=>tray.dropdownMenuItem({item:tray.text({text:(settings.genres.indexOf(g)>=0?"✓ ":"＋ ")+g}),onClick:"genre-"+g})),
                        tray.dropdownMenuSeparator({}),
                        tray.dropdownMenuItem({item:tray.text({text:(settings.genreMode==="ANY"?"✓ ":"")+"Match ANY selected genre"}),onClick:"genre-mode-any"}),
                        tray.dropdownMenuItem({item:tray.text({text:(settings.genreMode==="ALL"?"✓ ":"")+"Match ALL selected genres"}),onClick:"genre-mode-all"}),
                    ],
                }),
                tray.switch({
                    label: "English dub only",
                    value: settings.dubOnly, onChange: "dub-only"
                }),
                tray.flex({
                    items: [
                        tray.input({
                            label: "Minimum rating",
                            value: String(settings.minRating), placeholder: "0", onChange: "min-rating"
                        }),
                        tray.input({
                            label: "Maximum rating",
                            value: String(settings.maxRating), placeholder: "100", onChange: "max-rating"
                        }),
                    ],
                    gap: 2
                }),
                tray.switch({
                    label: "Taste recommendations",
                    value: settings.tasteEnabled, onChange: "taste-enabled"
                }),
                ...(settings.tasteEnabled ? [tray.text({
                    text: "Choose 1–5 anime you like.",
                    style: { opacity: "0.72", fontSize: "12px" }
                })] : []),
                ...(settings.tasteEnabled && settings.tasteSeeds.length ? [tray.flex({
                        items: settings.tasteSeeds.map((s, i) => tray.button({
                            label: "× " + s.title,
                            onClick: "remove-seed-" + i, size: "xs"
                        })),
                        gap: 1, style: { flexWrap: "wrap" }
                    })] : []),
                ...(settings.tasteEnabled && settings.tasteSeeds.length < 5 ? [tray.flex({
                        items: [
                            tray.input({
                                label: "Add anime you like",
                                fieldRef: tasteQueryRef, placeholder: "Search AniList…", onChange: "taste-query"
                            }),
                            tray.button({
                                label: "Search",
                                onClick: "taste-search", disabled: searching, loading: searching
                            })
                        ],
                        gap: 2
                    })] : []),
                ...(settings.tasteEnabled && tasteResults.length ? [tray.stack({
                        items: tasteResults.slice(0, 8).map((m, i) => tray.button({
                            label: titleOf(m),
                            onClick: "taste-result-" + i, size: "sm"
                        })),
                        gap: 1
                    })] : []),
                tray.button({
                    label: "Refresh roulette pool",
                    onClick: "refresh-pool", size: "xs", disabled: generating || searching
                }),
            ];
            return tray.stack({ items, gap: 3 });
        });
    });
}
