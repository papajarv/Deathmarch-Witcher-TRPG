/**
 * RingPortraitCropper — stripped-down debug build. Notifies at every step
 * so we can see what's actually firing.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";
const STAGE_PX = 400;
const OUTPUT_PX = 384;
const MASK_RATIO = 0.65;

/* Flag name where the crop transform is persisted on the actor. Read by the
 * portrait-toxicity sync path so variable portrait swaps inherit the same
 * circular framing the user chose here. */
export const PORTRAIT_CROP_FLAG = "portraitCrop";

/* Standalone rasterizer extracted from the cropper instance method so other
 * code paths (variable portrait swap → token texture) can apply the same
 * crop math to a different source image. Resolves to a base64 PNG data URL
 * with the circular mask applied, or null if loading the source image fails.
 *
 * Crop math is identical to the in-cropper version:
 *   r = output / stage           (output → stage pixel ratio)
 *   k = min(stage/W, stage/H)    (fit the source into the stage)
 *   s = k × scale × r            (final draw scale)
 *   draw origin = (output/2 + tx·r, output/2 + ty·r)
 * The same {tx, ty, scale} applied to a different source uses each image's
 * own natural dimensions for `k`, so the framing stays consistent as long
 * as the alternate portraits have a similar aspect ratio. */
export async function rasterizePortraitCrop(sourceImage, cropState = { tx: 0, ty: 0, scale: 1 }, opts = {}) {
    if (!sourceImage) return null;
    const stagePx   = opts.stagePx   ?? STAGE_PX;
    const outputPx  = opts.outputPx  ?? OUTPUT_PX;
    const maskRatio = opts.maskRatio ?? MASK_RATIO;

    const source = new Image();
    source.crossOrigin = "anonymous";
    source.src = sourceImage;
    await new Promise((resolve, reject) => {
        source.onload  = resolve;
        source.onerror = () => reject(new Error(`Image load failed: ${sourceImage}`));
    });

    const canvas = document.createElement("canvas");
    canvas.width  = outputPx;
    canvas.height = outputPx;
    const ctx = canvas.getContext("2d");

    const r = outputPx / stagePx;
    const k = Math.min(stagePx / source.naturalWidth, stagePx / source.naturalHeight);
    const s = k * (cropState.scale ?? 1) * r;

    ctx.setTransform(s, 0, 0, s,
        outputPx / 2 + (cropState.tx ?? 0) * r,
        outputPx / 2 + (cropState.ty ?? 0) * r);
    ctx.drawImage(source, -source.naturalWidth / 2, -source.naturalHeight / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    ctx.globalCompositeOperation = "destination-in";
    ctx.beginPath();
    ctx.arc(outputPx / 2, outputPx / 2, (outputPx / 2) * maskRatio, 0, Math.PI * 2);
    ctx.fill();

    return canvas.toDataURL("image/png");
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class RingPortraitCropper extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-ring-portrait-cropper",
        classes: ["witcher-ttrpg-death-march", "wdm-rpc"],
        tag: "form",
        window: {
            title: "Crop Portrait into Token Ring",
            icon: "fa-solid fa-crop-simple",
            resizable: false
        },
        position: { width: STAGE_PX + 64, height: "auto" },
        form: {
            handler: RingPortraitCropper._onSubmit,
            submitOnChange: false,
            closeOnSubmit: false
        },
        actions: {
            reset: RingPortraitCropper._onReset,
            apply: RingPortraitCropper._onApplyClick
        }
    };

    static PARTS = {
        main: { template: `systems/${SYSTEM_ID}/templates/applications/ring-portrait-cropper.hbs` }
    };

    constructor(options = {}) {
        const { actor, tokenConfigApp, sourceImage, ...rest } = options;
        super(rest);
        this.actor = actor ?? null;
        this.tokenConfigApp = tokenConfigApp ?? null;
        this.sourceImage = sourceImage || actor?.img || "";
        this._cropState = { tx: 0, ty: 0, scale: 1 };
        this._drag = null;
        console.log(`${SYSTEM_ID} | RPC ctor — actor: ${this.actor?.name}, src: ${this.sourceImage}`);
    }

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        ctx.sourceImage = this.sourceImage;
        ctx.stagePx = STAGE_PX;
        ctx.actorName = this.actor?.name ?? "";
        return ctx;
    }

    _onRender(context, options) {
        super._onRender?.(context, options);
        console.log(`${SYSTEM_ID} | RPC _onRender — element present: ${!!this.element}`);
        if (!this.element) return;
        try {
            this._wireDragAndZoom();
            this._applyTransform();
        } catch (err) {
            console.error(`${SYSTEM_ID} | RPC _onRender failed`, err);
        }
    }

    _img()   { return this.element?.querySelector('[data-img]')   ?? null; }
    _stage() { return this.element?.querySelector('[data-stage]') ?? null; }

    _applyTransform() {
        const img = this._img();
        if (!img) return;
        img.style.transform = `translate(calc(-50% + ${this._cropState.tx}px), calc(-50% + ${this._cropState.ty}px)) scale(${this._cropState.scale})`;
    }

    _wireDragAndZoom() {
        const stage = this._stage();
        const img = this._img();
        const zoomEl = this.element?.querySelector('[data-zoom]');
        if (!stage || !img) return;

        const onDown = (e) => {
            e.preventDefault();
            this._drag = { startX: e.clientX, startY: e.clientY, baseTx: this._cropState.tx, baseTy: this._cropState.ty };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        };
        const onMove = (e) => {
            if (!this._drag) return;
            this._cropState.tx = this._drag.baseTx + (e.clientX - this._drag.startX);
            this._cropState.ty = this._drag.baseTy + (e.clientY - this._drag.startY);
            this._applyTransform();
        };
        const onUp = () => {
            this._drag = null;
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        stage.addEventListener("mousedown", onDown);

        stage.addEventListener("wheel", (e) => {
            e.preventDefault();
            const dir = e.deltaY < 0 ? +1 : -1;
            const next = Math.min(4, Math.max(0.2, this._cropState.scale * (1 + dir * 0.08)));
            this._cropState.scale = next;
            if (zoomEl) zoomEl.value = String(next);
            this._applyTransform();
        }, { passive: false });

        if (zoomEl) {
            zoomEl.addEventListener("input", () => {
                this._cropState.scale = Number(zoomEl.value) || 1;
                this._applyTransform();
            });
        }
    }

    static async _onReset() {
        this._cropState = { tx: 0, ty: 0, scale: 1 };
        const zoomEl = this.element?.querySelector('[data-zoom]');
        if (zoomEl) zoomEl.value = "1";
        this._applyTransform();
    }

    /* Apply Crop button uses data-action="apply" instead of type="submit" so
     * we bypass the form handler entirely — V2 form handling has been the
     * mystery. Action handlers definitively fire. */
    static async _onApplyClick(event) {
        console.log(`${SYSTEM_ID} | RPC apply clicked`);
        event?.preventDefault?.();
        try {
            ui.notifications.info("Crop: starting…");
            if (!this.actor) {
                ui.notifications.error("Crop: no actor on cropper");
                return;
            }
            console.log(`${SYSTEM_ID} | RPC rasterizing…`);
            const dataUrl = await this._rasterizeToDataUrl();
            if (!dataUrl) {
                ui.notifications.error("Crop: rasterize returned null");
                return;
            }
            console.log(`${SYSTEM_ID} | RPC rasterized: ${dataUrl.length} chars; updating actor…`);
            ui.notifications.info(`Crop: rasterized (${Math.round(dataUrl.length / 1024)} KB), updating actor…`);
            /* Persist the crop transform too. The variable-portrait sync
             * (chrome/integrations/portrait-toxicity.js) reads this flag
             * and re-rasterizes each tier/condition image with the same
             * {tx, ty, scale} so the framing carries over to swapped
             * portraits — otherwise this initial crop gets clobbered the
             * next time toxicity ticks. */
            await this.actor.update({
                "prototypeToken.texture.src": dataUrl,
                [`flags.${SYSTEM_ID}.${PORTRAIT_CROP_FLAG}`]: { ...this._cropState }
            });
            console.log(`${SYSTEM_ID} | RPC actor.update done`);
            ui.notifications.info(`Crop: applied to ${this.actor.name}.`);
            await this.close();
        } catch (err) {
            console.error(`${SYSTEM_ID} | RPC apply failed`, err);
            ui.notifications.error(`Crop failed: ${err?.message ?? err}`);
        }
    }

    /* Kept as a fallback for any V2 path that still calls the form handler.
     * Routes through the same logic. */
    static async _onSubmit(event, form, formData) {
        return RingPortraitCropper._onApplyClick.call(this, event);
    }

    async _rasterizeToDataUrl() {
        if (!this.sourceImage) {
            console.warn(`${SYSTEM_ID} | RPC: no source image`);
            return null;
        }

        const source = new Image();
        source.crossOrigin = "anonymous";
        source.src = this.sourceImage;
        await new Promise((res, rej) => {
            source.onload = res;
            source.onerror = (e) => rej(new Error(`Image load failed: ${this.sourceImage}`));
        });

        const canvas = document.createElement("canvas");
        canvas.width = OUTPUT_PX;
        canvas.height = OUTPUT_PX;
        const ctx = canvas.getContext("2d");

        const r = OUTPUT_PX / STAGE_PX;
        const k = Math.min(STAGE_PX / source.naturalWidth, STAGE_PX / source.naturalHeight);
        const s = k * this._cropState.scale * r;

        ctx.setTransform(s, 0, 0, s, OUTPUT_PX / 2 + this._cropState.tx * r, OUTPUT_PX / 2 + this._cropState.ty * r);
        ctx.drawImage(source, -source.naturalWidth / 2, -source.naturalHeight / 2);
        ctx.setTransform(1, 0, 0, 1, 0, 0);

        ctx.globalCompositeOperation = "destination-in";
        ctx.beginPath();
        ctx.arc(OUTPUT_PX / 2, OUTPUT_PX / 2, (OUTPUT_PX / 2) * MASK_RATIO, 0, Math.PI * 2);
        ctx.fill();

        return canvas.toDataURL("image/png");
    }
}
