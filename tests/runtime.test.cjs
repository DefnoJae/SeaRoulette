const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const source = stripTypeScriptTypes(fs.readFileSync(require('node:path').join(__dirname, '../code.ts'), 'utf8'));
// Contract copied from Seanime v3.10.3 (2da73d9), components.go and the
// frontend registry. Returning a component from render is essential even
// though plugin.d.ts incorrectly declares builders' return type as void.
const schemas = {
    div: {items:'array'},
    stack: { items: 'array', gap: 'number' }, flex: { items: 'array', gap: 'number', direction: 'string' },
    text: { text: 'string' }, button: { label: 'string', onClick: 'string', intent: 'string', disabled: 'boolean', loading: 'boolean', size: 'string' },
    input: { label: 'string', value: 'string', placeholder: 'string', onChange: 'string', fieldRef: 'object', size: 'string' },
    select: { label: 'string', value: 'string', onChange: 'string', options: 'array' },
    checkbox: { label: 'string', value: 'boolean', onChange: 'string', size: 'string' },
    switch: { label: 'string', value: 'boolean', onChange: 'string', size: 'string' }, popover: { trigger: 'component', items: 'array' },
    dropdownMenu:{trigger:'component',items:'array',className:'string'},
    dropdownMenuItem:{item:'component',onClick:'string'},dropdownMenuSeparator:{},
};
const media = (id, genres = ['Comedy'], meanScore = 80) => ({ id, idMal: id, genres, meanScore, title: { romaji: 'Anime ' + id } });
function boot(options = {}) {
    let now = 100000, render, tree;
    const handlers = {}, rawHandlers = {}, timers = [], navigation = [], messages = [], requests = [], catalogFetches = [], requestTimes = [], collections = [];
    function advance(ms) {
        now += ms;
        while (timers.some(t => t.at <= now)) {
            const i = timers.findIndex(t => t.at <= now);
            timers.splice(i, 1)[0].fn();
        }
    }
    async function settle(promise) {
        let done = false, failure;
        Promise.resolve(promise).then(() => done = true, e => { failure = e; done = true; });
        for (let round = 0; !done && round < 1000; round++) {
            for (let i = 0; i < 100 && !done; i++)
                await Promise.resolve();
            if (!done && timers.length)
                advance(Math.max(0, Math.min(...timers.map(t => t.at)) - now));
        }
        assert.ok(done, 'Async handler completed');
        if (failure)
            throw failure;
    }
    const saved = structuredClone(options.settings || {});
    const storage = { settings: saved, ...structuredClone(options.storage || {}) };
    const entries = options.entries || [media(1), media(2), media(3)];
    const collection = options.collection || { MediaListCollection: { lists: [{ status: 'PLANNING', entries: entries.map(media => ({ status: 'PLANNING', media })) }] } };
    function validate(node) {
        assert.ok(node && typeof node === 'object' && schemas[node.type], 'No empty or unknown component');
        const props = node.props;
        for (const [name, value] of Object.entries(props)) {
            if (name === 'style') {
                assert.equal(typeof value, 'object');
                continue;
            }
            const type = schemas[node.type][name];
            assert.ok(type, `${node.type}.${name} is supported`);
            if (type === 'array')
                assert.ok(Array.isArray(value));
            else if (type === 'component')
                validate(value);
            else
                assert.equal(typeof value, type);
        }
        for (const child of props.items || [])
            validate(child);
        for (const key of ['onClick', 'onChange'])
            if (props[key])
                assert.equal(typeof handlers[props[key]], 'function');
    }
    const tray = { render(fn) { render = fn; }, update() { tree = render(); validate(tree); }, close() { }, onOpen() { } };
    for (const type of Object.keys(schemas))
        tray[type] = function (props) {
            assert.equal(arguments.length, 1, 'Use explicit object builder arguments');
            assert.ok(props && !Array.isArray(props) && typeof props === 'object');
            return { type, props };
        };
    const ctx = { newTray: () => tray, registerEventHandler: (name, fn) => { rawHandlers[name] = fn; handlers[name] = (...args) => settle(fn(...args)); },
        fetch: async (url, fetchOptions) => {
            if (url.includes('dubInfo.json')) {
                catalogFetches.push(url);
                if (options.fetch)
                    return options.fetch(url, fetchOptions);
                return { ok: true, status: 200, headers: {}, json: () => options.catalog || { dubbed: entries.map(m => m.idMal), incomplete: [] } };
            }
            const body = JSON.parse(fetchOptions.body);
            requests.push(body);
            requestTimes.push(now);
            if (options.fetch)
                return options.fetch(url, fetchOptions);
            let data;
            if (options.query)
                data = options.query(body);
            else if (body.variables.search)
                data = { Page: { media: [media(101), media(102)] } };
            else
                data = { Page: { media: body.variables.ids.map(id => ({ ...media(id), tags: [], recommendations: { edges: [] } })) } };
            return { ok: true, status: 200, headers: {}, json: () => ({ data }) };
        },
        fieldRef: (value) => ({ current: value, setValue(value) { this.current = value; } }),
        screen: { navigateTo: (path, params) => navigation.push({ path, params }) },
        toast: Object.fromEntries(['info', 'warning', 'error', 'success'].map(level => [level, text => messages.push({ level, text })])),
        setTimeout: (fn, delay) => { timers.push({ fn, at: now + delay }); return () => { }; } };
    const sandbox = { Date: class extends Date {
            static now() { return now; }
        }, Math: Object.create(Math), console: { error: () => { } },
        $ui: { register: fn => fn(ctx) }, $storage: { get: key => structuredClone(storage[key]), set: (key, value) => storage[key] = structuredClone(value) },
        // Match the installed manifest: reading a token must throw. Public
        // metadata queries must never call this API.
        $database: { anilist: { getToken: () => { throw Error('permission denied'); } } },
        $anilist: { getRawAnimeCollection: bypass => {
                collections.push(bypass);
                if (options.collectionError)
                    throw Error(options.collectionError);
                return collection;
            },
            customQuery: () => { throw Error('Native retrying helper must not be used'); } } };
    sandbox.Math.random = () => options.random ?? 0;
    if (options.withoutDatabase)
        delete sandbox.$database;
    vm.runInNewContext(source + '\ninit()', sandbox);
    tray.update();
    return { handlers, rawHandlers, settle, storage, navigation, messages, requests, catalogFetches, requestTimes, collections,
        render: () => { tray.update(); return tree; },
        advance,
        get tree() { return tree; } };
}
function nodes(root) { return [root, ...(root.props.items || []).flatMap(nodes), ...(root.props.trigger ? nodes(root.props.trigger) : []), ...(root.props.item ? nodes(root.props.item) : [])]; }
function generateButton(app) { return nodes(app.tree).find(n => n.props.onClick === 'generate'); }
test('500-title dub pool uses one external catalog download and zero AniList metadata requests',async()=>{
    const app=boot({settings:{dubOnly:true},entries:Array.from({length:500},(_,i)=>media(i+1)),catalog:{dubbed:[400],incomplete:[]}});
    await app.handlers.generate();assert.equal(app.navigation[0].params.id,'400');
    assert.equal(app.catalogFetches.length,1);assert.equal(app.requests.length,0);
    app.advance(5000);await app.handlers.generate();assert.equal(app.catalogFetches.length,1);
});
test('catalog matches MAL IDs, includes recorded partial dubs, excludes missing IDs, and ignores old negative cast results',async()=>{
    const app=boot({settings:{dubOnly:true},entries:[{...media(1),idMal:400},{...media(2),idMal:500},{...media(3),idMal:null}],catalog:{dubbed:[400,500],incomplete:[500]},storage:{dubCache:{'1':{value:false,checkedAt:100000}}}});
    await app.handlers.generate();assert.equal(app.navigation[0].params.id,'1');assert.equal(app.requests.length,0);
    app.advance(5000);await app.handlers.generate();assert.equal(app.navigation[1].params.id,'2');
});
test('saved catalog survives plugin restart without fetching',async()=>{
    const app=boot({settings:{dubOnly:true},storage:{dubCatalog:{dubbed:[2],incomplete:[],fetchedAt:100000}}});
    await app.handlers.generate();assert.equal(app.navigation[0].params.id,'2');assert.equal(app.catalogFetches.length,0);
});
test('catalog download failure uses a recent saved catalog but rejects missing/expired evidence',async()=>{
    const offline=()=>{throw Error('offline');};
    const app=boot({settings:{dubOnly:true},storage:{dubCatalog:{dubbed:[2],incomplete:[],fetchedAt:100000-2*86400000}},fetch:offline});
    await app.handlers.generate();assert.equal(app.navigation[0].params.id,'2');
    const empty=boot({settings:{dubOnly:true},fetch:offline});await empty.handlers.generate();assert.equal(empty.navigation.length,0);
    const expired=boot({settings:{dubOnly:true},storage:{dubCatalog:{dubbed:[2],incomplete:[],fetchedAt:100000-8*86400000}},fetch:offline});
    await expired.handlers.generate();assert.equal(expired.navigation.length,0);
});
test('tray returns a known root with valid components in every conditional branch', async () => {
    const app = boot();
    assert.equal(app.tree.type, 'stack');
    await app.handlers.generate();
    app.render();
    app.advance(5000);
    app.render();
});
test('Generate navigates immediately; disabled cooldown expires at five seconds; cycles do not repeat', async () => {
    const app = boot();
    await app.handlers.generate();
    assert.equal(app.navigation[0].path, '/entry');
    assert.equal(app.navigation[0].params.id, '1');
    assert.equal(generateButton(app).props.disabled, true);
    app.advance(4999);
    await app.handlers.generate();
    assert.equal(app.navigation.length, 1);
    app.advance(1);
    assert.equal(generateButton(app).props.disabled, false);
    for (let i = 0; i < 3; i++) {
        await app.handlers.generate();
        app.advance(5000);
    }
    assert.deepEqual(app.navigation.map(n => n.params.id), ['1', '2', '3', '1']);
    assert.equal(app.collections.length, 1);
    assert.equal(app.requests.length, 0);
});
test('list statuses are OR, categories are AND, duplicate entries are removed', async () => {
    const app = boot({ settings: { lists: ['PLANNING', 'PAUSED'], minRating: 75, maxRating: 100, genres: ['Romance', 'Comedy'], genreMode: 'ANY' }, collection: { MediaListCollection: { lists: [
                    { status: 'PLANNING', entries: [{ media: media(1, ['Comedy']) }, { media: media(2, ['Action']) }, { media: media(3, ['Romance'], 60) }] },
                    { status: 'PAUSED', entries: [{ media: media(1, ['Comedy']) }, { media: media(4, ['Romance']) }] },
                    { status: 'CURRENT', entries: [{ media: media(5, ['Comedy']) }] }
                ] } } });
    for (let i = 0; i < 3; i++) {
        await app.handlers.generate();
        app.advance(5000);
    }
    assert.deepEqual(app.navigation.map(n => n.params.id), ['1', '4', '1']);
});
test('ALL genres and inclusive rating bounds', async () => {
    const app = boot({ settings: { genres: ['Romance', 'Comedy'], genreMode: 'ALL', minRating: 75, maxRating: 90 }, entries: [media(1, ['Comedy'], 80), media(2, ['Romance', 'Comedy'], 75), media(3, ['Romance', 'Comedy'], 90), media(4, ['Romance', 'Comedy'], 91)] });
    for (let i = 0; i < 3; i++) {
        await app.handlers.generate();
        app.advance(5000);
    }
    assert.deepEqual(app.navigation.map(n => n.params.id), ['2', '3', '2']);
});
test('saved empty lists persist, invalid ratings are ignored, inverted ranges are rejected', async () => {
    const app = boot({ settings: { lists: [] } });
    await app.handlers.generate();
    assert.equal(app.collections.length, 0);
    await app.handlers['list-PLANNING']({ value: true });
    await app.handlers['min-rating']({ value: 'invalid' });
    assert.equal(app.storage.settings.minRating, 0);
    await app.handlers['min-rating']({ value: '90' });
    await app.handlers['max-rating']({ value: '80' });
    await app.handlers.generate();
    assert.equal(app.navigation.length, 0);
    await app.handlers['max-rating']({ value: '100' });
    const restored = boot({ settings: app.storage.settings });
    await restored.handlers['toggle-rating']();
    assert.equal(nodes(restored.tree).find(n => n.props.onChange === 'min-rating').props.value, '90');
});
test('refresh forces a fresh collection and resets the current cycle', async () => {
    const app = boot();
    await app.handlers.generate();
    app.advance(5000);
    await app.handlers.generate();
    assert.equal(app.navigation[1].params.id, '2');
    app.advance(5000);
    await app.handlers['refresh-pool']();
    await app.handlers.generate();
    assert.equal(app.navigation[2].params.id, '1');
    assert.deepEqual(app.collections, [false, true]);
});
test('old enabled taste settings do not block generation or send metadata requests',async()=>{
 for(const tasteSeeds of [[],[{id:101,title:'Old seed'}]]){
 const app=boot({withoutDatabase:true,settings:{dubOnly:true,tasteEnabled:true,tasteSeeds}});
 await app.handlers.generate();assert.equal(app.navigation.length,1);assert.equal(app.requests.length,0);
 assert.equal(Object.keys(app.handlers).some(n=>n.includes('taste')),false);
 await app.handlers['dub-only']({value:false});assert.equal('tasteEnabled' in app.storage.settings,false);assert.equal('tasteSeeds' in app.storage.settings,false);
 }
});
test('collection failures report the actual operation and underlying error', async () => {
    const app = boot({ collectionError: 'not logged in' });
    await app.handlers.generate();
    assert.equal(app.navigation.length, 0);
    assert.ok(app.messages.some(m => m.level === 'error' && m.text.includes('AniList collection loading failed: not logged in')));
    await app.handlers['refresh-pool']();
    assert.ok(app.messages.some(m => m.level === 'error' && m.text.includes('Collection refresh failed: not logged in')));
});
test('refresh preserves expensive caches and repeated refresh clicks do not send more collection requests', async () => {
    const app = boot({ storage: { dubCache: { '1': { value: true, checkedAt: 100000 } } }, settings: { dubOnly: true }, entries: [media(1)] });
    await app.handlers['refresh-pool']();
    await app.handlers['refresh-pool']();
    await app.handlers.generate();
    assert.deepEqual(app.collections, [true]);
    assert.equal(app.requests.length, 0);
});
test('outside discovery excludes every library status, applies filters and caches rerolls',async()=>{
 const app=boot({settings:{lists:['OUTSIDE'],dubOnly:true,minRating:75,genres:['Comedy']},
 collection:{MediaListCollection:{lists:[{status:'COMPLETED',entries:[{media:media(10)}]}]}},
 catalog:{dubbed:[10,20,21,22,23],incomplete:[]},
 query:()=>({Page:{pageInfo:{hasNextPage:true},media:[media(10),media(20),media(21),media(22,['Action']),media(23,['Comedy'],60)]}})});
 await app.handlers.generate();app.advance(5000);await app.handlers.generate();
 assert.deepEqual(app.navigation.map(n=>n.params.id),['20','21']);assert.equal(app.requests.length,1);
 assert.equal(app.catalogFetches.length,1);
 await app.handlers['refresh-pool']();app.advance(5000);await app.handlers.generate();
 assert.equal(app.requests.length,2);assert.equal(app.requests[1].variables.page,2);
});
test('outside and selected library statuses combine with OR and persist',async()=>{
 const app=boot({settings:{lists:['PLANNING']},query:()=>({Page:{pageInfo:{hasNextPage:false},media:[media(1),media(20)]}})});
 await app.handlers['list-OUTSIDE']({value:true});
 assert.ok(app.storage.settings.lists.includes('OUTSIDE'));
 for(let i=0;i<4;i++){await app.handlers.generate();app.advance(5000);}
 assert.deepEqual(app.navigation.map(n=>n.params.id),['1','2','3','20']);assert.equal(app.requests.length,1);
});
test('outside 429 never retries automatically and blocks clicks until Retry-After',async()=>{
 const app=boot({settings:{lists:['OUTSIDE']},fetch:()=>({ok:false,status:429,headers:{'Retry-After':'60'}})});
 await app.handlers.generate();assert.equal(app.requests.length,1);
 app.advance(59000);await app.handlers.generate();assert.equal(app.requests.length,1);
 app.advance(1000);assert.equal(app.requests.length,1);await app.handlers.generate();assert.equal(app.requests.length,2);
 assert.equal(app.navigation.length,0);
});
test('empty discovery makes one request and waits for manual refresh; stale work cannot navigate',async()=>{
 const app=boot({settings:{lists:['OUTSIDE']},query:()=>({Page:{pageInfo:{hasNextPage:false},media:[]}})});
 await app.handlers.generate();app.advance(60000);await app.handlers.generate();assert.equal(app.requests.length,1);
 await app.handlers['refresh-pool']();await app.handlers.generate();assert.equal(app.requests[1].variables.page,1);
 let release;
 const stale=boot({settings:{lists:['OUTSIDE']},fetch:()=>new Promise(r=>release=r)});
 const pending=stale.rawHandlers.generate();for(let i=0;i<20 && !release;i++)await Promise.resolve();
 await stale.handlers['list-OUTSIDE']({value:false});
 release({ok:true,status:200,json:()=>({data:{Page:{pageInfo:{hasNextPage:false},media:[media(20)]}}})});
 await stale.settle(pending);assert.equal(stale.navigation.length,0);
});
test('delayed discovery and dub fetches complete, and rejection releases the Generate guard',async()=>{
 const pending=[];
 const app=boot({settings:{lists:['OUTSIDE'],dubOnly:true},fetch:(url)=>new Promise((resolve,reject)=>pending.push({url,resolve,reject}))});
 async function waitForRequest(){for(let i=0;i<30 && !pending.length;i++)await Promise.resolve();assert.ok(pending.length);return pending.shift();}
 let spin=app.rawHandlers.generate();let req=await waitForRequest();
 req.reject(Error('connection closed'));await app.settle(spin);assert.equal(generateButton(app).props.disabled,false);
 app.advance(2500);spin=app.rawHandlers.generate();req=await waitForRequest();
 req.resolve({ok:true,status:200,json:()=>({data:{Page:{pageInfo:{hasNextPage:false},media:[media(20)]}}})});
 req=await waitForRequest();assert.ok(req.url.includes('dubInfo.json'));
 req.resolve({ok:true,status:200,json:()=>({dubbed:[20],incomplete:[]})});
 await app.settle(spin);assert.equal(app.navigation[0].params.id,'20');
});
test('redesigned tray sections expand safely and pills support multiple selections',async()=>{
 const app=boot();
 assert.equal(nodes(app.tree).some(n=>n.props.onChange==='min-rating'),false);
 assert.equal(nodes(app.tree).some(n=>n.props.onClick==='refresh-pool'),false);
 await app.handlers['toggle-rating']();await app.handlers['toggle-advanced']();
 assert.ok(nodes(app.tree).some(n=>n.props.onChange==='min-rating'));
 assert.ok(nodes(app.tree).some(n=>n.props.onClick==='refresh-pool'));
 await app.handlers['list-PAUSED']();await app.handlers['list-COMPLETED']();
 assert.deepEqual(app.storage.settings.lists,['PLANNING','PAUSED','COMPLETED']);
 await app.handlers['genre-Comedy']();await app.handlers['genre-Romance']();
 assert.deepEqual(app.storage.settings.genres,['Comedy','Romance']);
 await app.handlers['genre-mode-all']();assert.equal(app.storage.settings.genreMode,'ALL');
 await app.handlers['toggle-genres']();await app.handlers['toggle-genres']();assert.equal(nodes(app.tree).some(n=>n.props.onClick==='genre-Comedy'),false);
 await app.handlers['toggle-genres']();assert.ok(nodes(app.tree).find(n=>n.props.onClick==='genre-Comedy').props.label.startsWith('✓'));
 await app.handlers['toggle-rating']();await app.handlers['toggle-advanced']();
 assert.equal(nodes(app.tree).some(n=>n.props.onClick==='refresh-pool'),false);
 assert.equal(nodes(app.tree).some(n=>n.type==='checkbox'||n.type==='dropdownMenu'),false);
});
test('outside excludes titles from custom lists without a status',async()=>{
 const app=boot({settings:{lists:['OUTSIDE']},collection:{MediaListCollection:{lists:[{name:'Custom',entries:[{media:media(20)}]}]}},query:()=>({Page:{pageInfo:{hasNextPage:false},media:[media(20),media(21)]}})});
 await app.handlers.generate();assert.equal(app.navigation[0].params.id,'21');
});
