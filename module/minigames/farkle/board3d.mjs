/**
 * DiceBoard3D — procedural 3D dice on a flat top-down table for Farkle.
 *
 * Dice are Three.js BoxGeometry cubes skinned with the six engraved brass faces
 * sliced from the supplied dice_texture.png net. cannon-es runs the physics.
 * The camera looks straight down (orthographic) so every settled face is
 * unambiguous and the table reads as a flat surface.
 *
 * The table is a big open felt surface. Containment walls are INVISIBLE and
 * tall, so thrown dice always stay in play — there are no "lost" dice in this
 * layout (unlike the old walled gilt tray).
 *
 * Outcome model is THROWER-AUTHORITATIVE: this board runs real local physics,
 * the dice settle, and `readLiveValues()` reads the up-faces of the dice in
 * hand. The caller relays the read values to peers — no cross-machine sim is
 * attempted.
 *
 * Farkle interaction: after a throw settles the player clicks scoring dice to
 * SELECT them (bright glow), then the app commits the selection — committed
 * dice are SET ASIDE (frozen as static bodies, dim glow) and stay out of
 * subsequent rerolls within the turn. `prepareReroll()` brings the remaining
 * in-hand dice back to the edge; `newTurn()` (also used for hot dice) returns
 * all six to play.
 *
 * Performance: the render/physics loop runs ONLY while aiming or while dice are
 * in motion; at rest it stops and the GL canvas holds a static frame.
 */

import * as THREE from "../vendor/three.module.js";
import * as CANNON from "../vendor/cannon-es.js";
import { drawFace } from "./engine/dice.mjs";

// Furniture sizes (world units). The rollable surface fills the whole canvas;
// its half-extents (this._halfX / this._halfZ) are derived from the camera view
// in #computeView so the green felt reaches the window edges.
const WALL_T = 0.6, DIE = 1.55, DIE_H = DIE / 2;
const DROP_H = DIE_H + 5;      // dice spawn this high and fall onto the table
                               // (kept modest: a higher spawn projects above the
                               // frame under the iso camera and reads as dice
                               // "thrown outside the board" before they fall in)
// Containment walls are INVISIBLE, so make them comfortably taller than the
// drop height: otherwise a strong throw carries a die over the wall top while
// it is still falling and it lands off-camera. Must exceed DROP_H.
const WALL_H = DROP_H + 6;
const GRAVITY = -32;
// While aiming, the dice are HELD this high above the board (cupped in hand)
// and rattle, then are flung down into the well — not parked flat on the felt.
// Kept above the raised edge frame (FRAME_H) so the held dice clear it.
const HOLD_H = DIE_H + 3.0;

// Tavern table: a fixed-size green felt play area (the rollable bounds) inset
// into a wooden table slab, viewed isometrically.
const FELT_HX = 10.5, FELT_HZ = 10.5;                  // square felt half-extents = rollable bounds
const RIM = 1.6;                                       // margin between felt edge and table edge where the raised frame sits
const TABLE_HX = FELT_HX + RIM, TABLE_HZ = FELT_HZ + RIM;
const TABLE_THICK = 1.4;                               // slab thickness (its edge shows in iso)
const FRAME_H = 2.2;                                   // raised 3D edge-frame height above the board surface (TUNABLE)
// Isometric camera: 45° azimuth, ~37° elevation (classic tabletop look).
const ISO_DIR = new THREE.Vector3(1, 1.05, 1).normalize();
const ISO_DIST = 70;                                   // ortho — distance only affects clipping

const GLOW_SELECTED = 0x8a6a14; // bright gold: picked, not yet committed

// A die reads cleanly only when its up-face is near-vertical; resting higher
// than this means it landed on top of another die. Bad landings are re-thrown.
const FLAT_DOT = 0.9;           // up-normal·world-up below this ⇒ cocked/tilted
const STACK_Y = DIE_H * 1.5;    // resting centre above this ⇒ stacked on another die
const MAX_RELAND_TRIES = 3;     // re-throw bad dice this many times, then force flat
const MAX_DECLUMP_PASSES = 10;  // shove stacked dice off this many times in the sim

// Tavern art assets (sliced from the supplied texture pack).
const ASSETS = "systems/witcher-ttrpg-death-march/assets/farkle";

// Dice SFX: curated from the user's real dice recordings.
//  - `flick`: ONE short release tick at throw launch, volume scaled by throw
//    force. (No busy roll-rattle — you flick the dice, then they bounce.)
//  - `impact`: real per-collision bounce hits (single dice-on-table impacts
//    sliced from the user's bounce recording) — fired each time a die strikes
//    ANOTHER DIE, so the dice audibly collide and bounce.
//  - `board`: the same hits pitched down a few semitones, for a die striking the
//    BOARD/walls (a heavier, deeper thunk than a die-on-die click).
//  - `drag`: a soft tick for shuffling the clump under the cursor.
const SFX = {
    flick:  [1, 2].map(i => `${ASSETS}/sounds/flick-${i}.ogg`),
    impact: [1, 2, 3, 4, 5].map(i => `${ASSETS}/sounds/impact-${i}.ogg`),
    board:  [1, 2, 3, 4, 5].map(i => `${ASSETS}/sounds/board-${i}.ogg`),
    drag:   [1, 2, 3].map(i => `${ASSETS}/sounds/drag-${i}.ogg`)
};
const SFX_VOL = 0.7;          // master scale on all dice SFX (dialed down from full)
const SFX_MIN_IMPACT = 1.8;   // contact speed (m/s along normal) below which a hit is silent
const SFX_GAP_MS = 28;        // min spacing between impact hits (anti-machine-gun)
const SFX_DRAG_GAP_MS = 90;   // min spacing between drag ticks while shuffling the clump
const SFX_DRAG_DIST = 0.6;    // world units the clump must move to earn the next drag tick

// BoxGeometry material-group order is [+X, -X, +Y, -Y, +Z, -Z]. Assign pip
// values so opposite faces sum to 7 (a valid die).
const FACE_VALUES = [3, 4, 1, 6, 2, 5];
const UP_NORMALS = [
    { n: new CANNON.Vec3(1, 0, 0), v: 3 },
    { n: new CANNON.Vec3(-1, 0, 0), v: 4 },
    { n: new CANNON.Vec3(0, 1, 0), v: 1 },
    { n: new CANNON.Vec3(0, -1, 0), v: 6 },
    { n: new CANNON.Vec3(0, 0, 1), v: 2 },
    { n: new CANNON.Vec3(0, 0, -1), v: 5 }
];

// Axis-aligned rest orientations so a parked clump shows a mix of faces.
const REST_TILTS = [
    [0, 0], [Math.PI / 2, 0], [0, Math.PI / 2], [Math.PI, 0], [-Math.PI / 2, 0]
];

// Stylized gilt selection ring (flat, laid on the felt around a die).
function makeRingTexture() {
    const S = 128;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d");
    g.translate(S / 2, S / 2);
    g.strokeStyle = "#ffffff"; // tinted per-die via material.color
    g.lineCap = "round";
    g.beginPath(); g.arc(0, 0, S * 0.40, 0, Math.PI * 2); g.lineWidth = 6; g.stroke();
    g.beginPath(); g.arc(0, 0, S * 0.47, 0, Math.PI * 2); g.lineWidth = 2.5; g.stroke();
    g.lineWidth = 4;
    for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const r0 = S * 0.47, r1 = S * 0.53;
        g.beginPath();
        g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
        g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
        g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
}

export class DiceBoard3D {
    /**
     * @param {object} opts
     * @param {HTMLCanvasElement} opts.canvas
     * @param {number} opts.width
     * @param {number} opts.height
     * @param {number} [opts.dieCount=6]
     * @param {(result:{values:number[], lost:number}) => void} [opts.onSettled]
     * @param {(power:number) => void} [opts.onAim]   0..1 while aiming
     * @param {(values:number[]) => void} [opts.onSelectChange]  current selection
     * @param {(values:number[]) => void} [opts.onThrow]  drawn faces, fired at the
     *        instant a player releases a throw (before the tumble) so the result
     *        can be relayed to peers in parallel with the local animation
     * @param {boolean} [opts.asideOnRim=false]  park set-aside ("kept") dice ATOP
     *        the near (+Z) edge frame instead of in the felt row — used by dice
     *        poker so kept dice rest on the board's rim on the player's side.
     */
    constructor({ canvas, width, height, dieCount = 6, onSettled, onAim, onSelectChange, onThrow, asideOnRim = false } = {}) {
        this.canvas = canvas;
        this.dieCount = dieCount;
        this.onSettled = onSettled;
        this.onAim = onAim;
        this.onSelectChange = onSelectChange;
        this.onThrow = onThrow;
        this.asideOnRim = asideOnRim;

        this.dice = [];          // { mesh, body, mats, lost, setAside, selected, inHand }
        // Persistent per-seat "locked hand" props (dice poker only): static dice
        // resting on each seat's true rim edge so every player's hand stays put
        // between rolls. Map<seat, [{ mesh, mats }]>. Farkle never touches this.
        this._seatHands = new Map();
        this._seatHandEdge = new Map();  // seat → rim edge, so a partial re-lay re-centres
        this._rimSelect = null;          // seat whose rim dice are click-to-reroll (dice poker)
        this.thrown = false;
        this.restFrames = 0;
        this.throwStart = 0;
        this._relandTries = 0;   // bad-landing re-throw counter for the current throw
        this.aiming = false;
        this.interactive = true; // false while reading-only
        this.selectMode = false; // true after a throw: click dice to pick scorers
        this._asideNext = 0;     // next slot in the set-aside row (reset each turn)
        this._raf = null;
        this._last = 0;
        this._fps = 0;
        this._fpsAccum = 0;
        this._fpsFrames = 0;

        this.#initThree(width, height);
        this.#initPhysics();
        this.#buildTray();
        this.#buildDice();
        this.#initAim();
        this.newTurn();
        this.renderOnce();
    }

    /* ----------------------------- setup ------------------------------ */

    #initThree(width, height) {
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setSize(width, height, false);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        this.scene = new THREE.Scene();

        this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
        this.#computeView(width, height); // iso framing: positions camera + fits the frustum

        // Candlelit tavern mood: warm low ambient + a warm key light casting
        // soft dice shadows, plus a dim cool fill so shadowed faces aren't black.
        this.scene.add(new THREE.AmbientLight(0xffe6c2, 0.72));
        const key = new THREE.DirectionalLight(0xffd9a0, 1.0);
        key.position.set(-8, 20, 10);
        key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        const sc = key.shadow.camera;
        sc.left = -TABLE_HX - 2; sc.right = TABLE_HX + 2;
        sc.top = TABLE_HZ + 2; sc.bottom = -TABLE_HZ - 2;
        sc.near = 1; sc.far = 60;
        key.shadow.bias = -0.0008;
        this.scene.add(key);
        const fill = new THREE.DirectionalLight(0x9fb4d0, 0.28);
        fill.position.set(10, 8, -8);
        this.scene.add(fill);
    }

    /** Position the isometric orthographic camera and fit its frustum to the
     *  whole table (with dice-drop headroom) at the canvas aspect, so the table
     *  is fully framed and the projection isn't stretched. The rollable bounds
     *  are the fixed felt half-extents. */
    #computeView(width, height) {
        const aspect = width / height;
        this._halfX = FELT_HX;
        this._halfZ = FELT_HZ;

        this.camera.position.copy(ISO_DIR).multiplyScalar(ISO_DIST);
        this.camera.up.set(0, 1, 0);
        this.camera.lookAt(0, 0, 0);
        this.camera.near = 0.1;
        this.camera.far = ISO_DIST * 2 + 40;
        this.camera.updateMatrixWorld(true);

        // Project the table's bounding box (incl. drop headroom) into view space
        // and size the frustum to contain it, then expand to the canvas aspect.
        const inv = this.camera.matrixWorldInverse;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const v = new THREE.Vector3();
        for (const sx of [-TABLE_HX, TABLE_HX])
            for (const sz of [-TABLE_HZ, TABLE_HZ])
                for (const sy of [-TABLE_THICK, DROP_H + 1]) {
                    v.set(sx, sy, sz).applyMatrix4(inv);
                    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
                    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
                }
        // Generous margin so the tray floats with the live scene visible around
        // it (the window is transparent), rather than filling frame-to-frame.
        const m = 2.4;
        minX -= m; maxX += m; minY -= m; maxY += m;
        let cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        let halfW = (maxX - minX) / 2, halfH = (maxY - minY) / 2;
        if (halfW / halfH < aspect) halfW = halfH * aspect; else halfH = halfW / aspect;

        this.camera.left = cx - halfW; this.camera.right = cx + halfW;
        this.camera.top = cy + halfH; this.camera.bottom = cy - halfH;
        this.camera.updateProjectionMatrix();
    }

    #initPhysics() {
        this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0) });
        this.world.allowSleep = true;
        this.world.solver.iterations = 18; // crisper contacts so tumbling dice don't jitter or tunnel
        this.matDie = new CANNON.Material("die");
        this.matTray = new CANNON.Material("tray");
        // Felt is grippy and barely bouncy: high friction, low restitution.
        this.world.addContactMaterial(new CANNON.ContactMaterial(this.matDie, this.matTray, { friction: 0.55, restitution: 0.14 }));
        // Dice are slick and springy against EACH OTHER so they roll/bounce
        // apart instead of sticking together or stacking up.
        this.world.addContactMaterial(new CANNON.ContactMaterial(this.matDie, this.matDie, { friction: 0.28, restitution: 0.38 }));
    }

    /* ------------------------------ audio ----------------------------- */

    /** Play the single throw "flick" (random variant), volume scaled by throw
     *  force. One short release tick — the dice then bounce via #playImpact.
     *  Best-effort and local-only (not broadcast); each viewer sounds their own. */
    #playFlick(force = 0.5) {
        const bank = SFX.flick;
        if (!bank?.length) return;
        const src = bank[(Math.random() * bank.length) | 0];
        const t = Math.min(1, Math.max(0, force));
        const volume = (0.12 + t * 0.40) * SFX_VOL;
        try {
            foundry.audio?.AudioHelper?.play?.({ src, volume, loop: false, autoplay: true }, false);
        } catch (_) { /* audio is non-essential */ }
    }

    /** CANNON `collide` handler on every die body. The normal throw is simulated
     *  off-screen and then replayed (no live physics), so collisions can't be
     *  heard as they happen — instead, while `_capturing` we RECORD each loud
     *  impact tagged with the sim frame it lands on, and #replayFrame fires it
     *  when that frame is shown. A live re-toss (#reThrowBad) steps physics in
     *  #tick, so there we play immediately. */
    #onDieCollide(e) {
        const speed = Math.abs(e.contact?.getImpactVelocityAlongNormal?.() ?? 0);
        if (speed < SFX_MIN_IMPACT) return;
        // The other body: tray material ⇒ struck the board/walls (deeper thunk);
        // otherwise it hit another die (bright click).
        const board = e.body?.material === this.matTray;
        if (this._capturing) {
            const buf = this._impactBuf;
            const last = buf[buf.length - 1];
            // Thin near-duplicates (a die-die hit fires on both bodies): keep one
            // per ~2 sim frames, retaining the louder.
            if (last && this._capFrame - last.frame < 2) {
                if (speed > last.speed) { last.speed = speed; last.board = board; }
                return;
            }
            buf.push({ frame: this._capFrame, speed, board });
        } else if (this.thrown) {
            this.#playImpact(speed, board);
        }
    }

    /** Play one bounce-impact sample (random variant), volume scaled by contact
     *  speed and globally throttled so a flurry of contacts doesn't machine-gun.
     *  `board` true ⇒ a die hit the board/walls (deeper pitched-down bank). */
    #playImpact(speed, board = false) {
        const now = performance.now();
        if (now - (this._lastSfxAt ?? 0) < SFX_GAP_MS) return;
        this._lastSfxAt = now;
        const bank = board ? SFX.board : SFX.impact;
        if (!bank?.length) return;
        const src = bank[(Math.random() * bank.length) | 0];
        const t = Math.min(1, Math.max(0, (speed - SFX_MIN_IMPACT) / 9));
        const volume = (0.12 + t * 0.45) * SFX_VOL;
        try {
            foundry.audio?.AudioHelper?.play?.({ src, volume, loop: false, autoplay: true }, false);
        } catch (_) { /* audio is non-essential */ }
    }

    #addStaticBox(hx, hy, hz, pos, material, opts = {}) {
        const body = new CANNON.Body({ mass: 0, material });
        body.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)));
        body.position.set(pos.x, pos.y, pos.z);
        this.world.addBody(body);
        if (opts.visible) {
            const mesh = new THREE.Mesh(
                new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2),
                new THREE.MeshStandardMaterial({ color: opts.color ?? 0x6b4f22, roughness: 0.85 })
            );
            mesh.position.copy(pos);
            this.scene.add(mesh);
            this._trayMeshes.push(mesh);
        }
        return body;
    }

    /** Add a cosmetic (non-physics) mesh and track it for disposal. */
    #addDecor(geo, mat, pos, { cast = false, receive = false } = {}) {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(pos.x, pos.y, pos.z);
        mesh.castShadow = cast;
        mesh.receiveShadow = receive;
        this.scene.add(mesh);
        this._trayMeshes.push(mesh);
        return mesh;
    }

    /** Load a tiling albedo texture from the asset pack. Triggers a re-render
     *  on load because the board is otherwise idle (loop stopped at rest). */
    #loadTex(file, repeatU = 1, repeatV = 1, { color = true } = {}) {
        this._texLoader ??= new THREE.TextureLoader();
        this._loadedTex ??= [];
        const tex = this._texLoader.load(`${ASSETS}/${file}`, () => this.renderOnce());
        if (color) tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(repeatU, repeatV);
        tex.anisotropy = 8;
        this._loadedTex.push(tex);
        return tex;
    }

    #buildTray() {
        this._trayMeshes = [];

        // Wooden table slab: top flush at y=0, its thickness visible edge-on in iso.
        // Skinned with the tiling woodtexture so the bare margin around the frame
        // (and the slab's edges) read as real wood, not a flat fill.
        const wood = new THREE.MeshStandardMaterial({
            map: this.#loadTex("woodtexture.png", 4, 4), color: 0xffffff, roughness: 0.85
        });
        this.#addDecor(
            new THREE.BoxGeometry(TABLE_HX * 2, TABLE_THICK, TABLE_HZ * 2), wood,
            { x: 0, y: -TABLE_THICK / 2, z: 0 }, { receive: true });

        // Wooden play surface (board.png art) over the play area, sitting
        // slightly proud of the slab. Mapped once across the felt square so the
        // plank grain reads at its authored scale; neutral tint shows true albedo.
        const surface = new THREE.MeshStandardMaterial({
            map: this.#loadTex("board.png", 1, 1), color: 0xffffff, roughness: 0.82
        });
        this.#addDecor(
            new THREE.BoxGeometry(FELT_HX * 2, 0.12, FELT_HZ * 2), surface,
            { x: 0, y: 0.03, z: 0 }, { receive: true });

        // Carved frame adornment. `boardframetop` is a concentric square ring
        // with a transparent centre (border ~10.5% per side, inner window
        // ~79.3%): its runic carving caps a RAISED 3D wooden edge frame that
        // stands proud of the board so the play area sits in a recessed well.
        // Sizes and heights are TUNABLE — eyeball them in-browser. To make the
        // frame's inner window align with a world span S, size it S / 0.793.
        const frameMat = (file) => new THREE.MeshStandardMaterial({
            map: this.#loadTex(file, 1, 1), transparent: true, alphaTest: 0.5,
            roughness: 0.75, color: 0xffffff
        });

        // Raised 3D edge frame: four wooden rails standing FRAME_H proud of the
        // board around the felt. Their inner faces sit on the felt bound (where
        // the invisible containment walls are), so dice visibly bounce off the
        // frame and the play area reads as a recessed well. Skinned with a wood-
        // grain strip cropped from boardframebottom.png so the rails match the band.
        const railMat = new THREE.MeshStandardMaterial({
            map: this.#loadTex("boardrail.png", 4, 1), color: 0xffffff, roughness: 0.8
        });
        const railW = RIM;                       // rail thickness (felt edge → table edge)
        const railCx = FELT_HX + railW / 2;      // long-rail centre on X
        const railCz = FELT_HZ + railW / 2;      // end-rail centre on Z
        const sideHalfZ = FELT_HZ + railW;       // long rails span the full outer depth
        const endHalfX = FELT_HX + railW;        // end rails span the full outer width
        const mkRail = (hx, hz, x, z) => this.#addDecor(
            new THREE.BoxGeometry(hx * 2, FRAME_H, hz * 2), railMat,
            { x, y: FRAME_H / 2, z }, { cast: true, receive: true });
        mkRail(railW / 2, sideHalfZ, railCx, 0);    // +X
        mkRail(railW / 2, sideHalfZ, -railCx, 0);   // -X
        mkRail(endHalfX, railW / 2, 0, railCz);     // +Z
        mkRail(endHalfX, railW / 2, 0, -railCz);    // -Z

        // Carved runic frame caps the raised rails; its transparent inner window
        // rings the felt. Sits just above the rail tops.
        const topSize = FELT_HX * 2 / 0.793;
        const top = this.#addDecor(
            new THREE.PlaneGeometry(topSize, topSize), frameMat("boardframetop.png"),
            { x: 0, y: FRAME_H + 0.04, z: 0 }, { cast: false, receive: true });
        top.rotation.x = -Math.PI / 2;
        top.renderOrder = 1;

        // Physics floor (top at y=0) covering the whole table.
        this.#addStaticBox(TABLE_HX, 0.5, TABLE_HZ, { x: 0, y: -0.5, z: 0 }, this.matTray);

        // Invisible containment walls at the felt bounds, taller than the drop
        // height so a hard throw can't carry a die off the table.
        const hx = this._halfX, hz = this._halfZ;
        this.#addStaticBox(WALL_T / 2, WALL_H / 2, hz, { x: hx + WALL_T / 2, y: WALL_H / 2, z: 0 }, this.matTray);
        this.#addStaticBox(WALL_T / 2, WALL_H / 2, hz, { x: -hx - WALL_T / 2, y: WALL_H / 2, z: 0 }, this.matTray);
        this.#addStaticBox(hx + WALL_T, WALL_H / 2, WALL_T / 2, { x: 0, y: WALL_H / 2, z: hz + WALL_T / 2 }, this.matTray);
        this.#addStaticBox(hx + WALL_T, WALL_H / 2, WALL_T / 2, { x: 0, y: WALL_H / 2, z: -hz - WALL_T / 2 }, this.matTray);
    }

    #buildDice() {
        // Engraved brass faces from the supplied dice_texture.png net, sliced to
        // one square PNG per value. Material order is [+X,-X,+Y,-Y,+Z,-Z].
        this._faceTex = FACE_VALUES.map(v => this.#loadTex(`die_face_${v}.png`, 1, 1));
        const geo = new THREE.BoxGeometry(DIE, DIE, DIE);
        this._dieGeo = geo;
        this._ringTex = makeRingTexture();
        this._ringGeo = new THREE.PlaneGeometry(DIE * 1.85, DIE * 1.85);
        for (let i = 0; i < this.dieCount; i++) {
            // Low metalness keeps the painted brass albedo bright and legible —
            // high metalness needs an environment map to not read as near-black.
            const mats = this._faceTex.map(t => new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, metalness: 0.12 }));
            const mesh = new THREE.Mesh(geo, mats);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            this.scene.add(mesh);
            const body = new CANNON.Body({ mass: 1, material: this.matDie, allowSleep: true });
            body.addShape(new CANNON.Box(new CANNON.Vec3(DIE_H, DIE_H, DIE_H)));
            // Felt bleeds energy: dice slow and settle naturally instead of
            // sliding/spinning forever or stopping dead.
            body.linearDamping = 0.08;
            body.angularDamping = 0.12;
            body.sleepSpeedLimit = 0.15;
            body.sleepTimeLimit = 0.3;
            body.addEventListener("collide", (e) => this.#onDieCollide(e));
            this.world.addBody(body);
            // Sticky selection marker: a flat gilt ring laid on the felt.
            const ringMat = new THREE.MeshBasicMaterial({
                map: this._ringTex, transparent: true, opacity: 0.95, depthWrite: false
            });
            const ring = new THREE.Mesh(this._ringGeo, ringMat);
            ring.rotation.x = -Math.PI / 2;
            ring.visible = false;
            ring.renderOrder = 2;
            this.scene.add(ring);
            this.dice.push({
                mesh, body, mats, ring,
                weights: null,     // null → fair; else six relative landing weights
                lost: false, setAside: false, selected: false, inHand: true
            });
        }
    }

    /** Load a face texture from an arbitrary path (a Die item's uploaded image
     *  or a bundled skin under the asset pack). Unlike #loadTex it does not
     *  prefix the asset root and does not tile. Cached by URL: re-skinning to the
     *  same face art reuses the decoded texture instead of re-fetching + re-
     *  uploading it (which stutters the throw when seats alternate). The cache
     *  owns the textures and disposes them when the board is destroyed. */
    #loadFaceTex(url) {
        this._texLoader ??= new THREE.TextureLoader();
        this._faceTexCache ??= new Map();
        const cached = this._faceTexCache.get(url);
        if (cached) return cached;
        const tex = this._texLoader.load(url, () => this.renderOnce());
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        this._faceTexCache.set(url, tex);
        return tex;
    }

    /** Skin one die from a {pip: url} face map (missing pips fall back to the
     *  default brass face). No-op when the die already wears these faces, so
     *  swapping the acting seat in/out doesn't churn textures every turn. */
    #skinDie(d, faces) {
        const key = FACE_VALUES.map(v => faces?.[v] ?? "").join("|");
        if (d.skinKey === key) return;
        d.skinKey = key;
        d.mats.forEach((m, k) => {
            const url = faces?.[FACE_VALUES[k]];
            m.map = url ? this.#loadFaceTex(url) : this._faceTex[k];
            m.needsUpdate = true;
        });
    }

    /**
     * Apply per-die skins and weights. `profiles` is an array aligned with the
     * physical dice (index 0…dieCount-1); each entry is
     * `{ weights?: number[6], faces?: {1..6: url} }`. A null/short array resets
     * the unspecified dice to fair brass. Set-aside state is preserved.
     *
     * Weights are not faked in the physics; a loaded throw draws each die's face
     * exactly from its weights and the tumble is replayed onto that face (see
     * `#predeterminedThrow`), so the bias is precise rather than approximate.
     */
    setDieProfiles(profiles) {
        this.dice.forEach((d, i) => {
            const p = profiles?.[i] ?? null;
            d.weights = p?.weights ?? null;
            this.#skinDie(d, p?.faces ?? null);
        });
        this.renderOnce();
    }

    #refreshGlow(d) {
        // Only the live (uncommitted) selection is highlighted. Once a die is set
        // aside it parks in the aside row with no glow and no ring.
        const hex = d.selected ? GLOW_SELECTED : 0x000000;
        for (const m of d.mats) m.emissive.setHex(hex);
        if (d.ring) {
            d.ring.visible = d.selected;
            if (d.selected) {
                d.ring.material.color.setHex(0xe9c876);
                d.ring.material.opacity = 0.95;
                d.ring.position.set(d.body.position.x, 0.05, d.body.position.z);
            }
        }
    }

    /** Raycast a pointer event against the live dice; return the die hit or null. */
    #pickDie(e) {
        const rect = this.canvas.getBoundingClientRect();
        const ndc = {
            x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
            y: -((e.clientY - rect.top) / rect.height) * 2 + 1
        };
        this._raycaster.setFromCamera(ndc, this.camera);
        const meshes = this.dice.filter(d => !d.lost).map(d => d.mesh);
        const hit = this._raycaster.intersectObjects(meshes, false)[0];
        return hit ? this.dice.find(d => d.mesh === hit.object) : null;
    }

    /** Raycast a pointer event against one seat's static rim dice (dice poker). */
    #pickSeatDie(seat, e) {
        const row = this._seatHands.get(seat);
        if (!row) return null;
        const rect = this.canvas.getBoundingClientRect();
        const ndc = {
            x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
            y: -((e.clientY - rect.top) / rect.height) * 2 + 1
        };
        this._raycaster.setFromCamera(ndc, this.camera);
        const hit = this._raycaster.intersectObjects(row.map(d => d.mesh), false)[0];
        return hit ? row.find(d => d.mesh === hit.object) : null;
    }

    /* ------------------------------ aim ------------------------------- */

    #initAim() {
        this._origin = new THREE.Vector3(0, HOLD_H, -this._halfZ + 1.4);
        this._raycaster = new THREE.Raycaster();
        this._floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

        const arrowDir = new THREE.Vector3(0, 0, 1);
        this.aimArrow = new THREE.ArrowHelper(arrowDir, this._origin.clone(), 4, 0xe3c270, 1.2, 0.8);
        this.aimArrow.visible = false;
        this.scene.add(this.aimArrow);

        this.arcLine = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(new Array(24).fill(0).map(() => new THREE.Vector3())),
            new THREE.LineBasicMaterial({ color: 0xe8b552, transparent: true, opacity: 0.7 })
        );
        this.arcLine.visible = false;
        this.scene.add(this.arcLine);

        this._aim = { dirX: 0, dirZ: 1, power: 0 };
        this._onDown = e => this.#aimDown(e);
        this._onMove = e => this.#aimMove(e);
        this._onUp = e => this.#aimUp(e);
        this.canvas.addEventListener("pointerdown", this._onDown);
        window.addEventListener("pointermove", this._onMove);
        window.addEventListener("pointerup", this._onUp);
    }

    #pointerToFloor(e) {
        const rect = this.canvas.getBoundingClientRect();
        const ndc = {
            x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
            y: -((e.clientY - rect.top) / rect.height) * 2 + 1
        };
        this._raycaster.setFromCamera(ndc, this.camera);
        const hit = new THREE.Vector3();
        return this._raycaster.ray.intersectPlane(this._floorPlane, hit) ? hit : null;
    }

    /** Dice currently throwable: in hand, not lost, not set aside. */
    #throwable() {
        return this.dice.filter(d => d.inHand && !d.lost && !d.setAside);
    }

    #aimDown(e) {
        if (this._replay) return;

        // Rim-select (dice poker): tap the acting seat's rim dice to mark which
        // to reroll. Works even while the felt is otherwise disabled.
        if (this._rimSelect != null) {
            const d = this.#pickSeatDie(this._rimSelect, e);
            if (d) {
                d.selected = !d.selected;
                this.#refreshSeatGlow(d);
                this.renderOnce();
                this.onSelectChange?.(this.rimSelectedValues());
            }
            return;
        }

        if (!this.interactive || this.thrown) return;

        // In select mode the ONLY action is toggling an in-hand die; a press
        // anywhere else does nothing. Never fall through to a slingshot throw —
        // re-rolling happens via Set Aside → Roll Again, not by dragging here.
        if (this.selectMode) {
            const d = this.#pickDie(e);
            if (d && d.inHand && !d.lost && !d.setAside) {
                d.selected = !d.selected;
                this.#refreshGlow(d);
                this.renderOnce();
                this.onSelectChange?.(this.selectedValues());
            }
            return;
        }

        const p = this.#pointerToFloor(e);
        if (!p) return;
        const xMax = this._halfX - 2, zMax = this._halfZ - 2;
        this._anchor = new THREE.Vector3(
            Math.max(-xMax, Math.min(xMax, p.x)),
            HOLD_H,
            Math.max(-zMax, Math.min(zMax, p.z))
        );
        this._origin = this._anchor;
        const toThrow = this.#throwable();
        if (!toThrow.length) return;
        this.#parkDiceAt(this._anchor.x, this._anchor.z, toThrow, HOLD_H);
        this.aiming = true;
        this.aimArrow.visible = true;
        this.arcLine.visible = true;
        this.aimArrow.position.copy(this._anchor);
        this._aim = { dirX: 0, dirZ: 1, power: 0 };
        this.start();
    }

    #aimMove(e) {
        if (this.aiming) {
            const p = this.#pointerToFloor(e);
            if (!p) return;
            const pullX = p.x - this._anchor.x;
            const pullZ = p.z - this._anchor.z;
            const pull = Math.hypot(pullX, pullZ) || 1;
            const dirX = -pullX / pull;
            const dirZ = -pullZ / pull;
            const power = Math.min(pull / this._halfZ, 1);
            this._aim = { dirX, dirZ, power };
            this.aimArrow.position.copy(this._anchor);
            this.aimArrow.setDirection(new THREE.Vector3(dirX, 0.35, dirZ).normalize());
            this.aimArrow.setLength(2 + power * 7, 1.2, 0.8);
            this.#updateArc();
            this.onAim?.(power);
            return;
        }

        // Pre-grab: the throwable clump rides under the cursor like cupped dice.
        if (!this.interactive || this.thrown || this.selectMode || this._replay) return;
        if (!this.#isOverCanvas(e)) return;
        const p = this.#pointerToFloor(e);
        if (!p) return;
        const xMax = this._halfX - 2, zMax = this._halfZ - 2;
        const x = Math.max(-xMax, Math.min(xMax, p.x));
        const z = Math.max(-zMax, Math.min(zMax, p.z));
        this._origin = new THREE.Vector3(x, HOLD_H, z);
        const toThrow = this.#throwable();
        if (toThrow.length) {
            this.#parkDiceAt(x, z, toThrow, HOLD_H);
            this.#shakeHeld();
            this.#playDrag(x, z);
            this.renderOnce();
        }
    }

    /** Visual rattle for the held dice while aiming/dragging: jitter their meshes
     *  around the parked anchor each frame, harder as the pull (power) grows. The
     *  bodies stay asleep at HOLD_H — only the meshes shake, re-synced next frame. */
    #shakeHeld() {
        const amp = 0.06 + (this._aim?.power ?? 0) * 0.16;
        for (const d of this.#throwable()) {
            const p = d.body.position;
            d.mesh.position.set(
                p.x + (Math.random() - 0.5) * amp,
                p.y + (Math.random() - 0.5) * amp * 0.5,
                p.z + (Math.random() - 0.5) * amp);
            d.mesh.rotation.x += (Math.random() - 0.5) * amp * 0.4;
            d.mesh.rotation.y += (Math.random() - 0.5) * amp * 0.4;
            d.mesh.rotation.z += (Math.random() - 0.5) * amp * 0.4;
        }
    }

    // Soft shuffle tick while the clump is dragged under the cursor. Throttled by
    // both time and distance so a slow drag whispers and a still cursor is silent.
    #playDrag(x, z) {
        const last = this._dragPos;
        if (last) {
            const moved = Math.hypot(x - last.x, z - last.z);
            if (moved < SFX_DRAG_DIST) return;
        }
        const now = performance.now();
        if (now - (this._lastDragAt ?? 0) < SFX_DRAG_GAP_MS) return;
        this._lastDragAt = now;
        this._dragPos = { x, z };
        const bank = SFX.drag;
        if (!bank?.length) return;
        const src = bank[(Math.random() * bank.length) | 0];
        try {
            foundry.audio?.AudioHelper?.play?.(
                { src, volume: (0.06 + Math.random() * 0.04) * SFX_VOL, loop: false, autoplay: true }, false);
        } catch (_) { /* audio is non-essential */ }
    }

    #isOverCanvas(e) {
        const r = this.canvas.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right
            && e.clientY >= r.top && e.clientY <= r.bottom;
    }

    #aimUp() {
        if (!this.aiming) return;
        this.aiming = false;
        this.aimArrow.visible = false;
        this.arcLine.visible = false;
        if (this._aim.power > 0.05) this.throwDice(this._aim, null, { notify: true });
        else {
            // Released without a throw: settle the held dice back down onto the board.
            this.#parkDiceAt(this._anchor.x, this._anchor.z, this.#throwable());
            this.renderOnce();
        }
    }

    #launchVelocity({ dirX, dirZ, power }) {
        const speed = 4.5 + power * 13;
        // Modest upward kick: the dice already start high (DROP_H) and fall in.
        const up = 1.5 + power * 2.5;
        return new CANNON.Vec3(dirX * speed, up, dirZ * speed);
    }

    #updateArc() {
        const o = this._origin;
        const v = this.#launchVelocity(this._aim);
        const pts = [];
        for (let i = 0; i < 24; i++) {
            const t = i * 0.045;
            pts.push(new THREE.Vector3(
                o.x + v.x * t,
                Math.max(o.y + v.y * t + 0.5 * GRAVITY * t * t, -1.5),
                o.z + v.z * t
            ));
        }
        this.arcLine.geometry.setFromPoints(pts);
    }

    /* ---------------------------- gameplay ---------------------------- */

    /** Park the given dice clustered around (x,z), deterministic per index. `y`
     *  is the rest height: dice held for a throw float at HOLD_H; settled dice
     *  sit on the board (default). */
    #parkDiceAt(x, z, list, y = DIE_H + 0.02) {
        const n = list.length;
        const cols = Math.ceil(Math.sqrt(n));
        const rowCount = Math.ceil(n / cols);
        const step = DIE + 0.15;
        const jit = seed => (((seed * 9301 + 49297) % 233280) / 233280 - 0.5) * 0.16;
        list.forEach((d, i) => {
            const col = i % cols, row = Math.floor(i / cols);
            const ox = (col - (cols - 1) / 2) * step;
            const oz = (row - (rowCount - 1) / 2) * step;
            const yaw = ((i * 47) % 360) * Math.PI / 180;
            const [tiltX, tiltZ] = REST_TILTS[i % REST_TILTS.length];
            d.lost = false;
            d.body.wakeUp();
            d.body.velocity.setZero();
            d.body.angularVelocity.setZero();
            d.body.position.set(x + ox + jit(i * 2 + 1), y, z + oz + jit(i * 2 + 2));
            d.body.quaternion.setFromEuler(tiltX, yaw, tiltZ);
            d.body.sleep();
            this.#syncMesh(d);
        });
    }

    /** Scatter the given dice from the player's edge into a tumbling throw:
     *  stagger drop heights and fan out start positions/velocities so the dice
     *  separate rather than dropping as one clump. Spawn positions are clamped a
     *  full die inside the felt so a die can never start at/over a containment
     *  wall and fall outside the play area. */
    #scatter(hand, aim) {
        const v = this.#launchVelocity(aim);
        const spread = () => (Math.random() - 0.5);
        const innerX = this._halfX - DIE, innerZ = this._halfZ - DIE;
        hand.forEach((d, i) => {
            d.body.wakeUp();
            d.body.position.set(
                Math.max(-innerX, Math.min(innerX, d.body.position.x + spread() * 2.4)),
                DROP_H + i * 0.7,
                Math.max(-innerZ, Math.min(innerZ, d.body.position.z + spread() * 2.4)));
            d.body.quaternion.setFromEuler(
                spread() * Math.PI * 2, spread() * Math.PI * 2, spread() * Math.PI * 2);
            d.body.velocity.set(v.x + spread() * 4, Math.max(v.y * 0.4, 1.5), v.z + spread() * 4);
            d.body.angularVelocity.set(spread() * 34, spread() * 34, spread() * 34);
            this.#syncMesh(d);
        });
    }

    /**
     * Throw the in-hand dice.
     *
     * Every throw is predetermined: the face is drawn up-front (exactly from each
     * die's weights, or from an explicit `targets` array) and the tumble is
     * replayed onto it, so the bias is precise, there is no value-changes-as-it-
     * lands snap, AND the outcome is known the instant the throw is launched. That
     * last property is what lets a player's roll be relayed to peers in parallel
     * with the local animation (via `onThrow`) instead of only after it settles.
     *
     * @param {object} [aim]       slingshot aim {dirX,dirZ,power}
     * @param {number[]} [targets] explicit up-faces aligned to the in-hand dice,
     *                             overriding the weighted draw (relay/cosmetic use)
     * @param {object} [opts]
     * @param {boolean} [opts.notify] fire `onThrow(values)` at launch (the local
     *                             player's own roll); programmatic throws don't
     */
    throwDice(aim = this._aim, targets = null, { notify = false } = {}) {
        const hand = this.#throwable();
        if (!hand.length) return;
        this.#predeterminedThrow(hand, aim, targets, notify);
    }

    /** Draw each die's target face (exact, from its weights unless an explicit
     *  `targets` array is given), simulate the tumble off-screen to learn where
     *  each die naturally rests, then replay that recorded tumble with a cube-
     *  symmetry relabel baked in so every die lands flat on its target face.
     *  When `notify`, the drawn faces are announced (`onThrow`) before the tumble
     *  so the result relays to peers in parallel with this local animation. */
    #predeterminedThrow(hand, aim, targets = null, notify = false) {
        const want = hand.map((d, i) => targets?.[i] ?? drawFace(d.weights ?? undefined));
        if (notify) this.onThrow?.(want.slice());
        const sim = this.#simulateThrow(hand, aim);
        const rots = hand.map((d, i) => this.#relabelQuat(want[i], sim.faces[i]));
        // Hand the recorded tumble to the single render loop (#tick); it plays the
        // frames with the relabel baked in, then commits the rest pose and settles.
        // Recorded impacts ride along and fire from #replayFrame at their frame.
        this._replay = { hand, frames: sim.frames, rots, final: sim.final, i: 0, acc: 0, last: null,
                         impacts: sim.impacts ?? [], impactIdx: 0 };
        // One flick on release, scaled by throw force; bounces follow per-collision.
        this.#playFlick(aim?.power ?? 0.5);
        this.thrown = false;
        this.start();
    }

    /** Run the throw to rest WITHOUT rendering, recording every step so it can be
     *  replayed. Dice never stay stacked: any die that lands on top of another
     *  (or cocked) is shoved off and re-settled, and the roll-off is recorded into
     *  the same frame stream so it plays back as a natural tumble.
     *  Returns {frames, faces, final}: per-step transforms, the natural rest face
     *  of each die, and the final rest transform. */
    #simulateThrow(hand, aim) {
        const MAX_STEPS = 600;
        const frames = [];
        this._impactBuf = [];
        this._capturing = true;
        this.#scatter(hand, aim);
        this.#stepToRest(hand, frames, MAX_STEPS);
        for (let pass = 0; pass < MAX_DECLUMP_PASSES && hand.some(d => this.#isBadLanding(d)); pass++) {
            this.#shoveBadLandings(hand);
            this.#stepToRest(hand, frames, MAX_STEPS);
        }
        this._capturing = false;
        const impacts = this._impactBuf;
        this._impactBuf = null;
        const faces = hand.map(d => this.#dieValue(d));
        const final = hand.map(d => this.#snapshot(d));
        return { frames, faces, final, impacts };
    }

    /** Step physics until the hand comes to rest (or maxSteps), pushing one
     *  snapshot frame per step into `frames`. */
    #stepToRest(hand, frames, maxSteps) {
        let rest = 0;
        for (let step = 0; step < maxSteps; step++) {
            this._capFrame = frames.length;   // index the frame this step produces
            this.world.step(1 / 60);
            frames.push(hand.map(d => this.#snapshot(d)));
            const slow = hand.every(d =>
                d.body.velocity.lengthSquared() < 0.04 &&
                d.body.angularVelocity.lengthSquared() < 0.04);
            rest = slow ? rest + 1 : 0;
            if (rest > 22) break;
        }
    }

    /** Shove every stacked/cocked die sideways (away from the other dice, with a
     *  small lift + spin) so it rolls off whatever it landed on and settles flat
     *  on the felt instead of perching on another die. */
    #shoveBadLandings(hand) {
        const rnd = () => (Math.random() - 0.5);
        for (const d of hand) {
            if (!this.#isBadLanding(d)) continue;
            let dirX = 0, dirZ = 0;
            for (const o of hand) {
                if (o === d) continue;
                dirX += d.body.position.x - o.body.position.x;
                dirZ += d.body.position.z - o.body.position.z;
            }
            if (Math.hypot(dirX, dirZ) < 0.2) { dirX = rnd(); dirZ = rnd(); } // coincident → random
            const inv = 1 / (Math.hypot(dirX, dirZ) || 1);
            dirX *= inv; dirZ *= inv;
            d.body.wakeUp();
            d.body.velocity.set(dirX * 7 + rnd() * 2, 3, dirZ * 7 + rnd() * 2);
            d.body.angularVelocity.set(rnd() * 22, rnd() * 22, rnd() * 22);
        }
    }

    #snapshot(d) {
        const p = d.body.position, q = d.body.quaternion;
        return { px: p.x, py: p.y, pz: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
    }

    /** Cube-symmetry rotation (in the die's local frame) that maps the `target`
     *  face onto where the `natural` face rests, so postmultiplying a die's rest
     *  orientation by it makes `target` show up. For axis-aligned face normals
     *  setFromUnitVectors always yields an octahedral symmetry, so the cube looks
     *  geometrically identical — only the labelling rotates. */
    #relabelQuat(target, natural) {
        const nt = UP_NORMALS.find(u => u.v === target) ?? UP_NORMALS[0];
        const nn = UP_NORMALS.find(u => u.v === natural) ?? UP_NORMALS[0];
        const vt = new THREE.Vector3(nt.n.x, nt.n.y, nt.n.z);
        const vn = new THREE.Vector3(nn.n.x, nn.n.y, nn.n.z);
        return new THREE.Quaternion().setFromUnitVectors(vt, vn);
    }

    /** Advance the replay one rendered frame, paced to the recorded 60 Hz step
     *  regardless of display refresh. Returns false once the last frame is shown
     *  so #tick can finalize. */
    #replayFrame(now) {
        const r = this._replay;
        if (r.last == null) r.last = now;
        r.acc += (now - r.last) / 1000;
        r.last = now;
        const FRAME = 1 / 60;
        while (r.acc >= FRAME && r.i < r.frames.length - 1) { r.i++; r.acc -= FRAME; }
        // Fire any recorded bounce impacts whose sim frame the replay has reached.
        while (r.impactIdx < r.impacts.length && r.impacts[r.impactIdx].frame <= r.i) {
            const hit = r.impacts[r.impactIdx++];
            this.#playImpact(hit.speed, hit.board);
        }
        const frame = r.frames[r.i];
        r.hand.forEach((d, k) => {
            const f = frame[k];
            d.mesh.position.set(f.px, f.py, f.pz);
            d.mesh.quaternion.set(f.qx, f.qy, f.qz, f.qw).multiply(r.rots[k]);
        });
        this.renderer.render(this.scene, this.camera);
        return r.i < r.frames.length - 1;
    }

    /** Commit the replay's relabelled rest transforms to the bodies so
     *  readLiveValues is authoritative. */
    #commitReplayRest() {
        const r = this._replay;
        r.hand.forEach((d, k) => {
            const f = r.final[k];
            d.body.position.set(f.px, f.py, f.pz);
            const q = new THREE.Quaternion(f.qx, f.qy, f.qz, f.qw).multiply(r.rots[k]);
            d.body.quaternion.set(q.x, q.y, q.z, q.w);
            d.body.velocity.setZero();
            d.body.angularVelocity.setZero();
            this.#syncMesh(d);
        });
    }

    /** A die that landed cocked (no clear up-face) or stacked on another. */
    #isBadLanding(d) {
        if (d.body.position.y > STACK_Y) return true;
        let best = -Infinity;
        for (const { n } of UP_NORMALS) best = Math.max(best, d.body.quaternion.vmult(n).y);
        return best < FLAT_DOT;
    }

    /** In-hand dice that landed cocked (no clear up-face) or stacked on another. */
    #badLandings() {
        return this.dice.filter(d =>
            d.inHand && !d.setAside && !d.lost && this.#isBadLanding(d));
    }

    /** Re-toss only the badly-landed dice from a low scatter so they re-settle
     *  flat and apart. Resumes the physics loop; settling re-checks the landing. */
    #reThrowBad(bad) {
        const spread = () => (Math.random() - 0.5);
        bad.forEach((d, i) => {
            d.body.wakeUp();
            d.body.position.set(
                spread() * (this._halfX * 1.2),
                DROP_H + i * 0.7,
                spread() * (this._halfZ * 1.2));
            d.body.quaternion.setFromEuler(
                spread() * Math.PI * 2, spread() * Math.PI * 2, spread() * Math.PI * 2);
            d.body.velocity.set(spread() * 5, -2, spread() * 5);
            d.body.angularVelocity.set(spread() * 28, spread() * 28, spread() * 28);
            this.#syncMesh(d);
        });
        // No flick on the corrective re-toss (not a player throw); the live
        // physics here fires #onDieCollide directly, so the dice still bounce.
        this.thrown = true;
        this.restFrames = 0;
        this.throwStart = performance.now();
        this.start();
    }

    /** Last-resort guarantee: lay the in-hand dice flat in a separated grid,
     *  each showing the value it physically rolled, so every face is readable. */
    #layoutFlatReadable() {
        const hand = this.dice.filter(d => d.inHand && !d.setAside && !d.lost);
        const cols = Math.ceil(Math.sqrt(hand.length));
        const rows = Math.ceil(hand.length / cols);
        const step = DIE + 0.6;
        hand.forEach((d, i) => {
            const val = this.#dieValue(d);
            const col = i % cols, row = Math.floor(i / cols);
            d.body.wakeUp();
            d.body.position.set(
                (col - (cols - 1) / 2) * step,
                DIE_H + 0.02,
                (row - (rows - 1) / 2) * step);
            this.#orientToValue(d, val);
            d.body.sleep();
            this.#syncMesh(d);
        });
    }

    #atRest() {
        const slow = this.dice.every(d => {
            if (d.lost || d.setAside) return true;
            return d.body.velocity.lengthSquared() < 0.04 && d.body.angularVelocity.lengthSquared() < 0.04;
        });
        if (slow) this.restFrames++; else this.restFrames = 0;
        const timedOut = performance.now() - this.throwStart > 6000;
        return this.restFrames > 22 || timedOut;
    }

    #dieValue(d) {
        let bestDot = -Infinity, best = 1;
        for (const { n, v } of UP_NORMALS) {
            const wy = d.body.quaternion.vmult(n).y;
            if (wy > bestDot) { bestDot = wy; best = v; }
        }
        return best;
    }

    /** Read settled up-faces of the dice just thrown. Walls contain all dice. */
    readLiveValues() {
        const live = this.dice.filter(d => d.inHand && !d.setAside);
        const values = live.map(d => this.#dieValue(d));
        return { values, lost: 0 };
    }

    /* ----------------------- round orchestration ---------------------- */

    /** Fresh hand: all six dice in play, none aside, parked at the player's edge. */
    newTurn() {
        for (const d of this.dice) {
            d.lost = false;
            d.setAside = false;
            d.selected = false;
            d.inHand = true;
            d.mesh.visible = true;   // restore any die hidden by a prior reroll subset
            this.#makeDynamic(d);
            this.#refreshGlow(d);
        }
        this.selectMode = false;
        this.interactive = true;
        this.thrown = false;
        this.restFrames = 0;
        this._asideNext = 0;
        this.#parkDiceAt(0, -this._halfZ + 1.4, this.dice);
        this.renderOnce();
    }

    /** Bring the un-set-aside, non-lost dice back to the edge to be rethrown. */
    prepareReroll() {
        const hand = this.dice.filter(d => !d.setAside && !d.lost);
        for (const d of hand) { d.inHand = true; d.selected = false; this.#refreshGlow(d); }
        this.selectMode = false;
        this.interactive = true;
        this.thrown = false;
        this.restFrames = 0;
        this.#parkDiceAt(0, -this._halfZ + 1.4, hand);
        this.renderOnce();
    }

    /** Enter selection mode: click in-hand dice to pick the scoring ones. */
    enterSelect() {
        for (const d of this.dice) if (d.inHand && !d.setAside) { d.selected = false; this.#refreshGlow(d); }
        this.selectMode = true;
        this.interactive = true;
        this.thrown = false;
        this.restFrames = 0;
        this.renderOnce();
    }

    /** Up-faces of the dice currently selected (not yet committed). */
    selectedValues() {
        return this.dice.filter(d => d.selected).map(d => this.#dieValue(d));
    }

    /** Commit the current selection: freeze those dice as set-aside. */
    commitSelection() {
        for (const d of this.dice) {
            if (!d.selected) continue;
            d.selected = false;
            d.setAside = true;
            d.inHand = false;
            this.#makeStatic(d);
            if (!this.asideOnRim) this.#parkAside(d, this._asideNext++);
            this.#refreshGlow(d);
        }
        if (this.asideOnRim) this.#layoutRim();
        this.selectMode = false;
        this.renderOnce();
    }

    /** Lay a just-committed die flat along the player's (+z) border, value up,
     *  left-to-right by slot. Constants are TUNABLE — eyeball them in-browser. */
    #parkAside(d, slot) {
        const val = this.#dieValue(d);
        const x = -this._halfX + DIE_H + 0.5 + slot * (DIE + 0.22);
        const z = this._halfZ - DIE_H - 0.3;
        d.body.wakeUp();
        d.body.position.set(x, DIE_H + 0.02, z);
        this.#orientToValue(d, val, 0);
        d.body.sleep();
        this.#syncMesh(d);
    }

    /** Lay ALL set-aside dice flat ATOP the near (+Z) edge frame, value up,
     *  centred left-to-right. Used by dice poker (asideOnRim) so kept dice rest
     *  on the board's rim on the player's side rather than in the felt row. */
    #layoutRim() {
        const aside = this.dice.filter(d => d.setAside);
        const n = aside.length;
        const step = DIE + 0.25;
        const z = FELT_HZ + RIM / 2;             // centre of the +Z rail
        const y = FRAME_H + DIE_H + 0.02;        // resting on top of the frame
        aside.forEach((d, i) => {
            const val = this.#dieValue(d);
            const x = (i - (n - 1) / 2) * step;
            d.body.wakeUp();
            d.body.position.set(x, y, z);
            this.#orientToValue(d, val, 0);
            d.body.sleep();
            this.#syncMesh(d);
        });
    }

    /* --------------------- persistent seat hands ---------------------- */
    /* Dice poker only. A "seat hand" is a row of STATIC (non-physics) dice laid
     * flat on one of the four rim edges, value up, so a seat's locked dice stay
     * visible on its own side of the board while other seats play. The live
     * physics set (`this.dice`) is reused only by the seat currently rolling. */

    /** Quaternion that lands `value` face-up, with an optional yaw spin. */
    #valueUpQuat(value, yaw = 0) {
        const e = UP_NORMALS.find(u => u.v === value) ?? UP_NORMALS[0];
        const local = new THREE.Vector3(e.n.x, e.n.y, e.n.z);
        const q = new THREE.Quaternion().setFromUnitVectors(local, new THREE.Vector3(0, 1, 0));
        q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
        return q;
    }

    /** One static display die, optionally skinned from a {pip: url} face map. */
    #makeStaticDie(faces) {
        const mats = this._faceTex.map((t, k) => {
            const url = faces?.[FACE_VALUES[k]];
            return new THREE.MeshStandardMaterial({
                map: url ? this.#loadFaceTex(url) : t, roughness: 0.6, metalness: 0.12
            });
        });
        const mesh = new THREE.Mesh(this._dieGeo, mats);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        return { mesh, mats, value: 0, selected: false };
    }

    /** Lay a row of static dice along one rim edge ("N"|"S"|"E"|"W"), centred. */
    #layoutSeatHand(row, values, edge) {
        const n = row.length;
        const step = DIE + 0.25;
        const y = FRAME_H + DIE_H + 0.02;
        const rail = (h) => h + RIM / 2;
        row.forEach((d, i) => {
            const off = (i - (n - 1) / 2) * step;
            let x, z;
            if (edge === "N")      { x = off;  z = -rail(FELT_HZ); }
            else if (edge === "E") { x = rail(FELT_HX); z = off; }
            else if (edge === "W") { x = -rail(FELT_HX); z = off; }
            else                   { x = off;  z = rail(FELT_HZ); }   // "S" (near)
            d.mesh.position.set(x, y, z);
            d.mesh.quaternion.copy(this.#valueUpQuat(values[i], 0));
        });
    }

    /** Stamp `values` as a seat's locked hand on its rim edge, replacing any
     *  prior hand for that seat. `profiles` (per-die {faces}) skins the dice. */
    setSeatHand(seat, values, edge, profiles = null) {
        this.clearSeatHand(seat);
        const row = values.map((v, i) => {
            const d = this.#makeStaticDie(profiles?.[i]?.faces ?? null);
            d.value = v;
            return d;
        });
        this._seatHands.set(seat, row);
        this._seatHandEdge.set(seat, edge);
        this.#layoutSeatHand(row, values, edge);
        this.renderOnce();
    }

    /** True if `seat` already shows exactly `values` (as a multiset) on `edge` —
     *  lets a declarative re-assert skip a redundant restamp (which would dispose
     *  and rebuild the meshes, dropping any rim-select glow). */
    seatHandMatches(seat, values, edge) {
        const row = this._seatHands.get(seat);
        if (!row || row.length !== values.length) return false;
        if ((this._seatHandEdge.get(seat) ?? null) !== edge) return false;
        const have = row.map(d => d.value).sort();
        const want = [...values].sort();
        return have.every((v, i) => v === want[i]);
    }

    /** Remove one seat's persistent hand (e.g. when that seat starts rolling). */
    clearSeatHand(seat) {
        const row = this._seatHands.get(seat);
        if (!row) return;
        for (const { mesh, mats } of row) {
            this.scene.remove(mesh);
            for (const m of mats) m.dispose();
        }
        this._seatHands.delete(seat);
        this._seatHandEdge.delete(seat);
        if (this._rimSelect === seat) this._rimSelect = null;
    }

    /** Remove every persistent seat hand (new hand / teardown). */
    clearSeatHands() {
        for (const seat of [...this._seatHands.keys()]) this.clearSeatHand(seat);
        this.renderOnce();
    }

    /** Hide the live physics dice (the rolling seat's hand is now a seat prop). */
    hideLiveDice() {
        for (const d of this.dice) { d.mesh.visible = false; if (d.ring) d.ring.visible = false; }
        this.renderOnce();
    }

    /** Re-show the live physics dice for the seat about to roll. */
    showLiveDice() {
        for (const d of this.dice) if (!d.lost) d.mesh.visible = true;
        this.renderOnce();
    }

    /* ---------------- rim reroll selection (dice poker) ---------------- */
    // The acting seat's hand rests on its rim as static props; the player taps
    // the dice they want to REROLL (gold glow). On Roll those tapped dice lift
    // off the rim and tumble live in the centre, the rest stay put. The whole
    // mechanism is dead code from Farkle's path.

    /** Gold emissive on a static rim die when it's marked for reroll. */
    #refreshSeatGlow(d) {
        const hex = d.selected ? GLOW_SELECTED : 0x000000;
        for (const m of d.mats) m.emissive.setHex(hex);
    }

    /** Make a seat's rim dice click-to-reroll; clears any prior marks. */
    enterRimSelect(seat) {
        this._rimSelect = seat;
        const row = this._seatHands.get(seat);
        if (row) for (const d of row) { d.selected = false; this.#refreshSeatGlow(d); }
        this.renderOnce();
    }

    /** Leave rim-select mode (no throw / cancelled). */
    exitRimSelect() { this._rimSelect = null; }

    /** Up-faces currently marked for reroll on the rim-select seat. */
    rimSelectedValues() {
        const row = this._rimSelect != null ? this._seatHands.get(this._rimSelect) : null;
        return row ? row.filter(d => d.selected).map(d => d.value) : [];
    }

    /** Programmatically mark ONE not-yet-marked rim die showing `value`
     *  (animates an opponent choosing its reroll dice). Returns true if found. */
    selectOneRim(seat, value) {
        const row = this._seatHands.get(seat);
        if (!row) return false;
        const d = row.find(x => !x.selected && x.value === value);
        if (!d) return false;
        d.selected = true;
        this.#refreshSeatGlow(d);
        this.renderOnce();
        return true;
    }

    /** Drop every reroll mark on a seat's rim. */
    clearRimSelection(seat) {
        const row = this._seatHands.get(seat);
        if (!row) return;
        for (const d of row) { d.selected = false; this.#refreshSeatGlow(d); }
        this.renderOnce();
    }

    /** Remove the rim dice marked for reroll, leaving the kept ones (re-centred)
     *  on the rim. Returns how many were lifted. */
    liftRimSelection(seat) {
        return this.#liftRim(seat, d => d.selected);
    }

    /** Authoritative lift: keep exactly the dice matching `keepValues` (one rim
     *  die per value), lift the rest — independent of the cosmetic `selected`
     *  flags. Prevents a seat keeping its whole hand on the rim while its reroll
     *  subset also tumbles live (the value-match glow and engine keep diverging).
     */
    liftRimToKeep(seat, keepValues) {
        const row = this._seatHands.get(seat);
        if (!row) return 0;
        const want = [0, 0, 0, 0, 0, 0, 0];
        for (const v of keepValues ?? []) if (v >= 1 && v <= 6) want[v]++;
        const keepFlag = new Set();
        for (const d of row) {
            if (want[d.value] > 0) { want[d.value]--; keepFlag.add(d); }
        }
        return this.#liftRim(seat, d => !keepFlag.has(d));
    }

    /** Shared lift: remove rim dice for which `liftPred` is true, re-centre the
     *  rest. Returns how many were lifted. */
    #liftRim(seat, liftPred) {
        const row = this._seatHands.get(seat);
        if (!row) return 0;
        const lift = row.filter(liftPred);
        const keep = row.filter(d => !liftPred(d));
        for (const { mesh, mats } of lift) {
            this.scene.remove(mesh);
            for (const m of mats) m.dispose();
        }
        if (keep.length) {
            this._seatHands.set(seat, keep);
            this.#layoutSeatHand(keep, keep.map(d => d.value), this._seatHandEdge.get(seat) ?? "S");
        } else {
            this._seatHands.delete(seat);
            this._seatHandEdge.delete(seat);
        }
        this._rimSelect = null;
        this.renderOnce();
        return lift.length;
    }

    /** Arm exactly `count` live dice for a reroll throw (the lifted subset);
     *  hide and freeze the rest, whose kept faces still rest on the rim. With
     *  `interactive` the player slingshots the subset themselves (their own
     *  throw); otherwise throw it programmatically via autoThrow() (AI/opponent).
     *  readLiveValues() then returns only the armed subset. */
    armRerollSubset(count, interactive = false) {
        this.dice.forEach((d, i) => {
            const active = i < count;
            d.lost = !active;
            d.setAside = false;
            d.selected = false;
            d.inHand = active;
            d.mesh.visible = active;
            if (d.ring) d.ring.visible = false;
            if (active) {
                this.#makeDynamic(d);
            } else {
                // Tuck the kept (invisible) bodies far below the felt so they
                // can't collide with the rerolled dice tumbling above.
                this.#makeStatic(d);
                d.body.position.set(0, -50, 0);
                this.#syncMesh(d);
            }
            this.#refreshGlow(d);
        });
        this.selectMode = false;
        this.interactive = interactive;
        this.thrown = false;
        this.restFrames = 0;
        this.#parkDiceAt(0, -this._halfZ + 1.4, this.#throwable());
        this.renderOnce();
    }

    /** Dice set aside this turn (frozen, already scored). */
    get setAsideCount() { return this.dice.filter(d => d.setAside).length; }

    /** Tint the in-hand dice (e.g. red to signal a farkle). */
    setDiceTint(hex) {
        for (const d of this.dice) {
            if (!d.inHand || d.setAside || d.lost) continue;
            for (const m of d.mats) m.emissive.setHex(hex);
        }
        this.renderOnce();
    }

    /** Clear a tint, restoring each die's normal selection glow. */
    clearDiceTint() {
        for (const d of this.dice) if (d.inHand && !d.setAside && !d.lost) this.#refreshGlow(d);
        this.renderOnce();
    }

    /* ------------------- programmatic (opponent) play ----------------- */

    /** Draw the predetermined up-faces for the dice currently in hand (exactly
     *  from each die's weights), WITHOUT throwing. Lets the AI driver learn the
     *  outcome at launch and relay it to peers in parallel with its own local
     *  animation — same record-then-replay guarantee a player throw gets via
     *  `onThrow`, just sourced up-front. Call AFTER newTurn()/prepareReroll() so
     *  the throwable set matches the hand about to be thrown. */
    drawInHandValues(rng = Math.random) {
        return this.#throwable().map(d => drawFace(d.weights ?? undefined, rng));
    }

    /** Throw the in-hand dice with a randomised aim (used to animate the
     *  opponent's roll). Settling fires onSettled like a player throw. When
     *  `targets` is given the dice land on exactly those faces (relayed roll). */
    autoThrow(targets = null) {
        const toThrow = this.#throwable();
        if (!toThrow.length) return;
        // Opponent owns the board: lock out player input so the dice can't be
        // grabbed/re-thrown once they settle (newTurn/prepareReroll re-enable
        // interactivity when setting up, and `thrown` only blocks input mid-flight).
        this.interactive = false;
        this.selectMode = false;
        const x = (Math.random() - 0.5) * (this._halfX - 4);
        const z = -this._halfZ + 1.4;
        this.#parkDiceAt(x, z, toThrow, HOLD_H);
        this._origin = new THREE.Vector3(x, HOLD_H, z);
        const ang = (Math.random() - 0.5) * 0.5;
        const power = 0.55 + Math.random() * 0.4;
        this.throwDice({ dirX: Math.sin(ang), dirZ: Math.cos(ang), power }, targets);
    }

    /** Glow ONE not-yet-selected in-hand die showing `value` (used to animate the
     *  opponent picking its scoring dice one at a time). Returns true if found. */
    selectOne(value) {
        for (const d of this.dice) {
            if (!d.inHand || d.setAside || d.lost || d.selected) continue;
            if (this.#dieValue(d) === value) {
                d.selected = true;
                this.#refreshGlow(d);
                this.renderOnce();
                return true;
            }
        }
        return false;
    }

    /** Clear any pending (uncommitted) selection glow. */
    clearSelection() {
        for (const d of this.dice) if (d.selected) { d.selected = false; this.#refreshGlow(d); }
        this.renderOnce();
    }

    #orientToValue(d, value, yawAngle = Math.random() * Math.PI * 2) {
        const entry = UP_NORMALS.find(u => u.v === value) ?? UP_NORMALS[0];
        const local = new THREE.Vector3(entry.n.x, entry.n.y, entry.n.z);
        const q = new THREE.Quaternion().setFromUnitVectors(local, new THREE.Vector3(0, 1, 0));
        const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawAngle);
        q.premultiply(yaw);
        d.body.quaternion.set(q.x, q.y, q.z, q.w);
        d.body.velocity.setZero();
        d.body.angularVelocity.setZero();
    }

    #makeStatic(d) {
        d.body.velocity.setZero();
        d.body.angularVelocity.setZero();
        d.body.type = CANNON.Body.STATIC;
        d.body.updateMassProperties();
        d.body.sleep();
    }

    #makeDynamic(d) {
        d.body.type = CANNON.Body.DYNAMIC;
        d.body.mass = 1;
        d.body.updateMassProperties();
        d.body.wakeUp();
    }

    /** Lock the board for read-only display. */
    disableBoard() {
        this.interactive = false;
        this.selectMode = false;
        this._rimSelect = null;
        this.aiming = false;
        this.aimArrow.visible = false;
        this.arcLine.visible = false;
        this.renderOnce();
    }

    /* ----------------------------- loop ------------------------------- */

    start() {
        if (this._raf != null) return;
        this._last = performance.now();
        this._raf = requestAnimationFrame(t => this.#tick(t));
    }

    stop() {
        if (this._raf != null) cancelAnimationFrame(this._raf);
        this._raf = null;
    }

    #tick(now) {
        // Predetermined throw: play the recorded tumble instead of stepping
        // physics. On the last frame, commit the rest pose and settle.
        if (this._replay) {
            const more = this.#replayFrame(now);
            if (more) {
                this._raf = requestAnimationFrame(t => this.#tick(t));
                return;
            }
            this.#commitReplayRest();
            this._replay = null;
            this.stop();
            this.renderer.render(this.scene, this.camera);
            this.onSettled?.(this.readLiveValues());
            return;
        }

        const dt = Math.min((now - this._last) / 1000, 1 / 30);
        this._last = now;

        this.world.step(1 / 60, dt, 6);
        for (const d of this.dice) this.#syncMesh(d);
        if (this.aiming) this.#shakeHeld();   // rattle the held dice while aiming

        this._fpsAccum += dt; this._fpsFrames++;
        if (this._fpsAccum >= 1) {
            this._fps = Math.round(this._fpsFrames / this._fpsAccum);
            this._fpsAccum = 0; this._fpsFrames = 0;
        }

        this.renderer.render(this.scene, this.camera);

        if (this.thrown && this.#atRest()) {
            this.thrown = false;
            this.stop();
            // Reject cocked/stacked landings: re-toss the offenders a few times,
            // then force a flat readable layout so the result is never ambiguous.
            const bad = this.#badLandings();
            if (bad.length) {
                if (this._relandTries < MAX_RELAND_TRIES) {
                    this._relandTries++;
                    this.#reThrowBad(bad);
                    return;
                }
                this.#layoutFlatReadable();
            }
            this._relandTries = 0;
            const result = this.readLiveValues();
            this.#syncAll();
            this.renderer.render(this.scene, this.camera);
            this.onSettled?.(result);
            return;
        }
        if (!this.thrown && !this.aiming) { this.stop(); return; }

        this._raf = requestAnimationFrame(t => this.#tick(t));
    }

    get fps() { return this._fps; }

    #syncMesh(d) {
        const q = d.body.quaternion, p = d.body.position;
        d.mesh.quaternion.set(q.x, q.y, q.z, q.w);
        d.mesh.position.set(p.x, p.y, p.z);
        if (d.ring?.visible) d.ring.position.set(p.x, 0.05, p.z);
    }
    #syncAll() { for (const d of this.dice) this.#syncMesh(d); }

    renderOnce() { this.renderer.render(this.scene, this.camera); }

    setSize(width, height) {
        // Reallocating the drawing buffer clears the canvas; skip when the size
        // is unchanged so repeated re-fits (every app refresh) don't flicker.
        if (width === this._sizeW && height === this._sizeH) return;
        this._sizeW = width; this._sizeH = height;
        this.renderer.setSize(width, height, false);
        this.#computeView(width, height);
        this.renderOnce();
    }

    /* ---------------------------- teardown ---------------------------- */

    dispose() {
        this.stop();
        this._replay = null;
        this.canvas.removeEventListener("pointerdown", this._onDown);
        window.removeEventListener("pointermove", this._onMove);
        window.removeEventListener("pointerup", this._onUp);

        for (const seat of [...(this._seatHands?.keys() ?? [])]) this.clearSeatHand(seat);

        this._dieGeo?.dispose();
        this._ringGeo?.dispose();
        this._ringTex?.dispose();
        for (const d of this.dice ?? []) {
            for (const m of d.mats) m.dispose();
            d.ring?.material.dispose();
        }
        for (const t of this._faceTexCache?.values() ?? []) t.dispose();
        for (const t of this._faceTex ?? []) t.dispose();
        for (const mesh of this._trayMeshes ?? []) { mesh.geometry.dispose(); mesh.material.dispose(); }
        for (const t of this._loadedTex ?? []) t.dispose();
        this.arcLine?.geometry.dispose();
        this.arcLine?.material.dispose();

        this.renderer.dispose();
        this.renderer.forceContextLoss?.();
        this.scene = this.world = this.dice = null;
    }
}
