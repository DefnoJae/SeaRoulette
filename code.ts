function init() {
    $ui.register((ctx) => {
        const LISTS = [
            ["CURRENT", "Watching"], ["PLANNING", "Planning"], ["PAUSED", "Paused"],
            ["COMPLETED", "Completed"], ["DROPPED", "Dropped"], ["REPEATING", "Repeating"], ["OUTSIDE", "Outside library"],
        ];
        const GENRES = ["Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"];
        type Settings = {
            lists: string[];
            dubOnly: boolean;
            minRating: number;
            maxRating: number;
            genres: string[];
            genreMode: "ANY" | "ALL";
        };
        let settings: Settings = loadSettings();
        let cooldownUntil = 0;
        let used: number[] = [];
        let cachedPool: any[] = [];
        let cacheKey = "";
        let lastPick = "";
        let collectionCache: any = null;
        let generating = false;
        let revision = 0;
        let lastRefreshAt = -Infinity;
        let discovery: any[] | null = null;
        let discoveryPage = 1;
        let discoveryHasNext = true;
        let blockedUntil = 0;
        let lastDiscoveryAt = -Infinity;
        const DUB_URL = "https://raw.githubusercontent.com/MAL-Dubs/MAL-Dubs/main/data/dubInfo.json";
        let dubCatalog: any = $storage.get("dubCatalog");
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
            };
        }
        function save() { $storage.set("settings", settings); }
        function ratingValue(value: any, fallback: number): number {
            const n = Number(value ?? fallback);
            return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback;
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
        async function loadDiscovery(expectedRevision: number) {
            if (discovery !== null) return;
            if (Date.now() < blockedUntil)
                throw new Error("AniList rate limited. Wait " + Math.ceil((blockedUntil - Date.now()) / 1000) + "s, then click Generate. No automatic retry.");
            const delay = Math.max(0, lastDiscoveryAt + 2500 - Date.now());
            if (delay) await new Promise<void>(resolve => ctx.setTimeout(resolve, delay));
            if (expectedRevision !== revision) return;
            lastDiscoveryAt = Date.now();
            const response = await ctx.fetch("https://graphql.anilist.co", {
                method: "POST", headers: {"Content-Type":"application/json"}, timeout:15, noCloudflareBypass:true,
                body: JSON.stringify({query: "query($page:Int!){Page(page:$page,perPage:50){pageInfo{hasNextPage} media(type:ANIME,sort:POPULARITY_DESC){id idMal genres meanScore title{userPreferred english romaji}}}}", variables:{page:discoveryPage}}),
            });
            if (response.status === 429) {
                const key = Object.keys(response.headers || {}).find(k => k.toLowerCase() === "retry-after");
                const seconds = Number(key ? response.headers[key] : 60);
                blockedUntil = Date.now() + (Number.isFinite(seconds) ? Math.max(1,seconds) : 60) * 1000;
                throw new Error("AniList rate limited. No automatic retry; wait before clicking Generate again.");
            }
            if (!response.ok) throw new Error("AniList HTTP " + response.status);
            const result = response.json();
            if (result?.errors?.length) throw new Error(String(result.errors[0].message));
            const page = result?.data?.Page;
            if (!Array.isArray(page?.media) || typeof page?.pageInfo?.hasNextPage !== "boolean")
                throw new Error("Invalid discovery response");
            if (expectedRevision !== revision) return;
            discovery = page.media;
            discoveryHasNext = page.pageInfo.hasNextPage;
        }
        function buildPool(): any[] {
            const key = JSON.stringify([settings.lists, settings.dubOnly, settings.minRating, settings.maxRating, settings.genres, settings.genreMode]);
            if (key === cacheKey)
                return cachedPool;
            let pool = flattenCollection();
            if (settings.lists.indexOf("OUTSIDE") >= 0) {
                const libraryIds: Record<string, boolean> = {};
                for (const list of collectionCache.MediaListCollection.lists)
                    for (const entry of (list?.entries || []))
                        if (entry?.media?.id) libraryIds[String(entry.media.id)] = true;
                const seen: Record<string, boolean> = {};
                for (const m of discovery || []) {
                    if (!m?.id || libraryIds[String(m.id)] || seen[String(m.id)]) continue;
                    seen[String(m.id)] = true;
                    pool.push(m);
                }
            }
            pool = pool.filter(passesBasic);
            cachedPool = pool;
            cacheKey = key;
            used = [];
            return pool;
        }
        function choose(pool: any[]): any {
            let available = pool.filter((m: any) => used.indexOf(Number(m.id)) < 0);
            if (!available.length) {
                used = [];
                available = pool.slice();
            }
            return available[Math.floor(Math.random() * available.length)];
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
            generating = true;
            tray.update();
            let stage = "AniList collection loading";
            const generationRevision = revision;
            try {
                // Always load the full collection so outside picks exclude every status.
                flattenCollection();
                if (settings.lists.indexOf("OUTSIDE") >= 0) {
                    stage = "Outside-library discovery";
                    await loadDiscovery(generationRevision);
                    if (generationRevision !== revision) return;
                }
                let pool = buildPool();
                if (settings.dubOnly) {
                    stage = "English dub catalog loading";
                    await loadDubCatalog();
                    if (generationRevision !== revision)
                        return;
                    pool = pool.filter(hasEnglishDub);
                }
                if (!pool.length) {
                    ctx.toast.warning(settings.lists.indexOf("OUTSIDE") >= 0 ? "SeaRoulette: no matches in this batch. Refresh roulette pool to try the next 50 titles." : "SeaRoulette: no anime matched these filters.");
                    return;
                }
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
        ctx.registerEventHandler("generate", generate);
        ctx.registerEventHandler("refresh-pool", () => {
            if (generating)
                return;
            if (Date.now() - lastRefreshAt < 60000) {
                ctx.toast.info("SeaRoulette: the collection was refreshed recently. Try Generate.");
                return;
            }
            lastRefreshAt = Date.now();
            try {
                collectionCache = $anilist.getAnimeCollection(true);
                if (settings.lists.indexOf("OUTSIDE") >= 0 && discovery !== null) {
                    discoveryPage = discoveryHasNext ? discoveryPage + 1 : 1;
                    discovery = null;
                }
                // Keep the valid dub catalog on refresh.
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
        for (const item of LISTS)
            ctx.registerEventHandler("list-" + item[0], (e: any) => setArrayValue(settings.lists, item[0], typeof e?.value === "boolean" ? e.value : settings.lists.indexOf(item[0]) < 0));
        for (const g of GENRES)
            ctx.registerEventHandler("genre-" + g, (e: any) => setArrayValue(settings.genres, g, typeof e?.value === "boolean" ? e.value : settings.genres.indexOf(g) < 0));
        ctx.registerEventHandler("genre-mode-any", () => {settings.genreMode="ANY";invalidate();});
        ctx.registerEventHandler("genre-mode-all", () => {settings.genreMode="ALL";invalidate();});
        ctx.registerEventHandler("dub-only", (e: any) => { settings.dubOnly = !!(e?.value ?? e); invalidate(); });
        tray.render(() => {
            const seconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
            const items: any[] = [
                tray.text({
                    text: "SeaRoulette 0.1.9",
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
                tray.text({text:"Lists",style:{fontWeight:"600"}}),
                tray.div({
                    style:{display:"grid",gridTemplateColumns:"repeat(3, minmax(0, 1fr))",gap:"8px"},
                    items: LISTS.map(x=>tray.checkbox({label:x[1],value:settings.lists.indexOf(x[0])>=0,onChange:"list-"+x[0],size:"sm"})),
                }),
                ...(settings.lists.indexOf("OUTSIDE") >= 0 ? [tray.text({text:"Outside library: 50-title batches by popularity. Refresh loads the next batch.",style:{fontSize:"12px",opacity:"0.7"}})] : []),
                tray.flex({gap:2,
                    items:[
                        tray.text({text:"Genres",style:{fontWeight:"600"}}),
                        tray.button({label:"ANY",onClick:"genre-mode-any",size:"xs",intent:settings.genreMode==="ANY"?"primary-subtle":"gray"}),
                        tray.button({label:"ALL",onClick:"genre-mode-all",size:"xs",intent:settings.genreMode==="ALL"?"primary-subtle":"gray"}),
                    ],
                }),
                tray.div({
                    style:{display:"grid",gridTemplateColumns:"repeat(3, minmax(0, 1fr))",gap:"8px"},
                    items:GENRES.map(g=>tray.checkbox({label:g,value:settings.genres.indexOf(g)>=0,onChange:"genre-"+g,size:"sm"})),
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
                tray.button({
                    label: "Refresh roulette pool",
                    onClick: "refresh-pool", size: "xs", disabled: generating
                }),
            ];
            return tray.stack({ items, gap: 3 });
        });
    });
}
