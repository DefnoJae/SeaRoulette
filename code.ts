function init() {
  $ui.register((ctx) => {
    const LISTS = [
      ["CURRENT", "Watching"], ["PLANNING", "Planning"], ["PAUSED", "Paused"],
      ["COMPLETED", "Completed"], ["DROPPED", "Dropped"], ["REPEATING", "Repeating"],
    ]
    const GENRES = ["Action","Adventure","Comedy","Drama","Ecchi","Fantasy","Horror","Mahou Shoujo","Mecha","Music","Mystery","Psychological","Romance","Sci-Fi","Slice of Life","Sports","Supernatural","Thriller"]

    type Settings = {
      lists: string[], dubOnly: boolean, minRating: number, maxRating: number,
      genres: string[], genreMode: "ANY"|"ALL", tasteEnabled: boolean,
      tasteSeeds: Array<{id:number,title:string}>
    }

    let settings: Settings = loadSettings()
    let cooldownUntil = 0
    let used: number[] = []
    let cachedPool: any[] = []
    let cacheKey = ""
    let lastPick = ""
    let tasteQuery = ""
    let tasteResults: any[] = []

    const tray = ctx.newTray({
      withContent: true,
      width: "430px",
      iconUrl: "https://raw.githubusercontent.com/DefnoJae/SeaRoulette/main/icon.png",
    })

    function loadSettings(): Settings {
      const saved = $storage.get("settings") as any
      return {
        lists: Array.isArray(saved?.lists) && saved.lists.length ? saved.lists.map(String) : ["PLANNING"],
        dubOnly: !!saved?.dubOnly,
        minRating: Number(saved?.minRating ?? 0),
        maxRating: Number(saved?.maxRating ?? 100),
        genres: Array.isArray(saved?.genres) ? saved.genres.map(String) : [],
        genreMode: saved?.genreMode === "ALL" ? "ALL" : "ANY",
        tasteEnabled: !!saved?.tasteEnabled,
        tasteSeeds: Array.isArray(saved?.tasteSeeds) ? saved.tasteSeeds.slice(0,5) : [],
      }
    }
    function save() { $storage.set("settings", settings) }
    function titleOf(m:any) { return String(m?.title?.userPreferred || m?.title?.english || m?.title?.romaji || "Untitled") }
    function setArrayValue(arr:string[], value:string, on:boolean) {
      const exists = arr.indexOf(value) >= 0
      if (on && !exists) arr.push(value)
      if (!on && exists) arr.splice(arr.indexOf(value), 1)
      invalidate()
    }
    function invalidate() { cachedPool = []; cacheKey = ""; used = []; save(); tray.update() }

    function flattenCollection(): any[] {
      const collection:any = $anilist.getAnimeCollection(false)
      const lists = collection?.MediaListCollection?.lists || []
      const out:any[] = []
      const seen:Record<string,boolean> = {}
      for (const list of lists) {
        const status = String(list?.status || "")
        if (settings.lists.indexOf(status) < 0) continue
        for (const entry of (list?.entries || [])) {
          const media = entry?.media
          if (!media?.id || seen[String(media.id)]) continue
          seen[String(media.id)] = true
          out.push(media)
        }
      }
      return out
    }

    function passesBasic(m:any): boolean {
      if (m?.isAdult) return false
      const rating = Number(m?.meanScore || 0)
      if (settings.minRating > 0 && rating < settings.minRating) return false
      if (settings.maxRating < 100 && rating > settings.maxRating) return false
      if (settings.genres.length) {
        const mg = (m?.genres || []).map(String)
        const hits = settings.genres.filter(g => mg.indexOf(g) >= 0).length
        if (settings.genreMode === "ALL" ? hits !== settings.genres.length : hits === 0) return false
      }
      return true
    }

    function hasEnglishDub(id:number): boolean {
      try {
        const token = $database.anilist.getToken()
        if (!token) return false
        const q:any = $anilist.customQuery({
          query: `query($id:Int){Media(id:$id,type:ANIME){characters(perPage:1){edges{voiceActors(language:ENGLISH){id}}}}}`,
          variables: { id },
        }, token)
        return !!q?.data?.Media?.characters?.edges?.some((e:any) => (e?.voiceActors || []).length > 0)
      } catch (_) { return false }
    }

    function buildPool(): any[] {
      const key = JSON.stringify([settings.lists,settings.dubOnly,settings.minRating,settings.maxRating,settings.genres,settings.genreMode])
      if (cachedPool.length && key === cacheKey) return cachedPool
      let pool = flattenCollection().filter(passesBasic)
      if (settings.dubOnly) {
        ctx.toast.info("SeaRoulette: checking English dub availability…")
        pool = pool.filter((m:any) => hasEnglishDub(Number(m.id)))
      }
      cachedPool = pool
      cacheKey = key
      used = []
      return pool
    }

    function tasteScore(m:any): number {
      if (!settings.tasteEnabled || !settings.tasteSeeds.length) return 1
      let score = 0
      const candidateGenres = (m?.genres || []).map(String)
      for (const seed of settings.tasteSeeds) {
        try {
          const d:any = $anilist.getAnimeDetails(Number(seed.id))
          const sg = (d?.genres || []).map(String)
          const overlap = sg.filter((g:string) => candidateGenres.indexOf(g) >= 0).length
          score += overlap * 12
          const recs = d?.recommendations?.edges || []
          if (recs.some((e:any) => Number(e?.node?.mediaRecommendation?.id) === Number(m.id))) score += 55
        } catch (_) {}
      }
      return Math.max(1, score)
    }

    function choose(pool:any[]): any {
      let available = pool.filter((m:any) => used.indexOf(Number(m.id)) < 0)
      if (!available.length) { used = []; available = pool.slice() }
      if (!settings.tasteEnabled || !settings.tasteSeeds.length) {
        return available[Math.floor(Math.random() * available.length)]
      }
      const weighted = available.map((m:any) => ({m, w:tasteScore(m)}))
      const total = weighted.reduce((s:number,x:any) => s + x.w, 0)
      let roll = Math.random() * total
      for (const x of weighted) { roll -= x.w; if (roll <= 0) return x.m }
      return weighted[weighted.length-1]?.m
    }

    function generate() {
      const left = cooldownUntil - Date.now()
      if (left > 0) { ctx.toast.warning("SeaRoulette: wait " + Math.ceil(left/1000) + "s before spinning again."); return }
      if (!settings.lists.length) { ctx.toast.warning("SeaRoulette: select at least one AniList list."); return }
      const pool = buildPool()
      if (!pool.length) { ctx.toast.warning("SeaRoulette: no anime matched these filters."); return }
      const pick = choose(pool)
      if (!pick) return
      used.push(Number(pick.id))
      lastPick = titleOf(pick)
      cooldownUntil = Date.now() + 5000
      tray.update()
      tray.close()
      ctx.screen.navigateTo("/entry?id=" + Number(pick.id))
      ctx.toast.success("SeaRoulette picked " + lastPick)
      ctx.scheduleTask(() => tray.update(), 5000)
    }

    function searchTaste() {
      const q = tasteQuery.trim()
      if (!q) { tasteResults=[]; tray.update(); return }
      try {
        const r:any = $anilist.listAnime(1,q,8,undefined,undefined,undefined,undefined,undefined,undefined,undefined,false)
        tasteResults = r?.Page?.media || r?.page?.media || r?.Media || r?.media || []
      } catch (e) { tasteResults=[]; ctx.toast.error("SeaRoulette: taste search failed.") }
      tray.update()
    }

    ctx.registerEventHandler("generate", generate)
    ctx.registerEventHandler("refresh-pool", () => { invalidate(); ctx.toast.success("SeaRoulette pool refreshed.") })
    ctx.registerEventHandler("min-rating", (e:any) => { settings.minRating=Math.max(0,Math.min(100,Number(e?.value ?? e ?? 0))); invalidate() })
    ctx.registerEventHandler("max-rating", (e:any) => { settings.maxRating=Math.max(0,Math.min(100,Number(e?.value ?? e ?? 100))); invalidate() })
    ctx.registerEventHandler("genre-mode", (e:any) => { settings.genreMode=String(e?.value ?? e)==="ALL"?"ALL":"ANY"; invalidate() })
    ctx.registerEventHandler("taste-query", (e:any) => { tasteQuery=String(e?.value ?? e ?? "") })
    ctx.registerEventHandler("taste-search", searchTaste)

    for (const item of LISTS) ctx.registerEventHandler("list-"+item[0], (e:any) => setArrayValue(settings.lists,item[0],!!(e?.value ?? e)))
    for (const g of GENRES) ctx.registerEventHandler("genre-"+g, (e:any) => setArrayValue(settings.genres,g,!!(e?.value ?? e)))
    ctx.registerEventHandler("dub-only", (e:any) => { settings.dubOnly=!!(e?.value ?? e); invalidate() })
    ctx.registerEventHandler("taste-enabled", (e:any) => { settings.tasteEnabled=!!(e?.value ?? e); invalidate() })
    ctx.registerEventHandler("clear-seeds", () => { settings.tasteSeeds=[]; invalidate() })

    for (let i=0;i<8;i++) ctx.registerEventHandler("taste-result-"+i, () => {
      const m=tasteResults[i]; if(!m) return
      if(settings.tasteSeeds.some(x=>Number(x.id)===Number(m.id))) return
      if(settings.tasteSeeds.length>=5){ctx.toast.warning("SeaRoulette: taste filter supports at most 5 anime.");return}
      settings.tasteSeeds.push({id:Number(m.id),title:titleOf(m)}); tasteResults=[]; tasteQuery=""; invalidate()
    })
    for (let i=0;i<5;i++) ctx.registerEventHandler("remove-seed-"+i, () => { settings.tasteSeeds.splice(i,1); invalidate() })

    tray.render(() => {
      const seconds = Math.max(0,Math.ceil((cooldownUntil-Date.now())/1000))
      tray.stack([
        tray.text("SeaRoulette", {style:{fontSize:"20px",fontWeight:"700"}}),
        tray.text("Set your pool once, then spin straight to an anime page.", {style:{opacity:"0.72"}}),
        tray.button(seconds ? "Spin again in "+seconds+"s" : "🎲 Generate", {onClick:"generate",intent:"primary",disabled:seconds>0,size:"lg"}),
        lastPick ? tray.text("Last pick: "+lastPick,{style:{opacity:"0.7",fontSize:"12px"}}) : null,

        tray.text("Lists", {style:{fontWeight:"700",marginTop:"8px"}}),
        tray.flex(LISTS.map(x => tray.checkbox(x[1], {value:settings.lists.indexOf(x[0])>=0,onChange:"list-"+x[0]})), {gap:8}),

        tray.switch("English dub only", {value:settings.dubOnly,onChange:"dub-only"}),
        tray.flex([
          tray.input("Minimum rating", {value:String(settings.minRating),placeholder:"0",onChange:"min-rating"}),
          tray.input("Maximum rating", {value:String(settings.maxRating),placeholder:"100",onChange:"max-rating"}),
        ], {gap:8}),

        tray.text("Genres", {style:{fontWeight:"700",marginTop:"8px"}}),
        tray.select("Genre matching", {value:settings.genreMode,onChange:"genre-mode",options:[{label:"Match any selected genre",value:"ANY"},{label:"Match all selected genres",value:"ALL"}]}),
        tray.flex(GENRES.map(g => tray.checkbox(g,{value:settings.genres.indexOf(g)>=0,onChange:"genre-"+g})),{gap:6}),

        tray.text("Taste filter", {style:{fontWeight:"700",marginTop:"10px"}}),
        tray.switch("Recommend based on anime I like", {value:settings.tasteEnabled,onChange:"taste-enabled"}),
        tray.text("Choose 1–5 anime. SeaRoulette weights matching genres and AniList recommendations while still respecting every filter above.",{style:{opacity:"0.72",fontSize:"12px"}}),
        tray.flex(settings.tasteSeeds.map((s,i)=>tray.button("× "+s.title,{onClick:"remove-seed-"+i,size:"xs"})),{gap:6}),
        settings.tasteSeeds.length < 5 ? tray.flex([
          tray.input("Add anime you like", {value:tasteQuery,placeholder:"Search AniList…",onChange:"taste-query"}),
          tray.button("Search",{onClick:"taste-search"})
        ],{gap:6}) : null,
        tasteResults.length ? tray.stack(tasteResults.slice(0,8).map((m,i)=>tray.button(titleOf(m),{onClick:"taste-result-"+i,size:"sm"})),{gap:4}) : null,

        tray.button("Refresh roulette pool",{onClick:"refresh-pool",size:"xs"}),
        tray.text("Each spin opens the anime immediately. Picks do not repeat until the current eligible pool is exhausted.",{style:{opacity:"0.6",fontSize:"11px"}}),
      ].filter(Boolean) as any[])
    })
  })
}