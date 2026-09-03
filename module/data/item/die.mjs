/**
 * DieData — a physical gaming die, used as a Farkle stake/skin.
 *
 * Six face images and six face weights. The images reskin the 3D dice in the
 * Farkle minigame (one texture per pip value); the weights bias the rolled
 * outcome so loaded dice can be modelled. A fair die leaves every weight at 1.
 *
 * Faces are flat per-index fields (faceNImage / faceNWeight) rather than an
 * ArrayField — flat fields sidestep the v2-sheet ArrayField reset/merge
 * pitfalls and read straight into the board's per-value texture map.
 *
 * An empty faceNImage means "use the system's default face texture" for that
 * pip; a weight of 0 means that face can never land.
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

const faceImage = () => new fields.FilePathField({ categories: ["IMAGE"], required: false });
const faceWeight = () => new fields.NumberField({ initial: 1, min: 0 });

export class DieData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),

            // Market rarity on the shared RAW availability scale.
            availability: new fields.StringField({ initial: "common" }),

            // Per-pip face art (pip value 1–6). Empty ⇒ system default texture.
            face1Image: faceImage(),
            face2Image: faceImage(),
            face3Image: faceImage(),
            face4Image: faceImage(),
            face5Image: faceImage(),
            face6Image: faceImage(),

            // Per-pip landing weights (relative). All-equal ⇒ a fair die.
            face1Weight: faceWeight(),
            face2Weight: faceWeight(),
            face3Weight: faceWeight(),
            face4Weight: faceWeight(),
            face5Weight: faceWeight(),
            face6Weight: faceWeight()
        };
    }

    /** Face textures keyed by pip value (1–6); empty entries omitted. */
    get faceImages() {
        const out = {};
        for (let v = 1; v <= 6; v++) {
            const img = this[`face${v}Image`];
            if (img) out[v] = img;
        }
        return out;
    }

    /** Landing weights as a 6-element array indexed [0]→face 1 … [5]→face 6. */
    get faceWeights() {
        return [1, 2, 3, 4, 5, 6].map(v => this[`face${v}Weight`] ?? 1);
    }

    /** True when every weight is equal (an unloaded die). */
    get isFair() {
        const w = this.faceWeights;
        return w.every(x => x === w[0]);
    }

    calcWeight() {
        return this.weight * this.quantity;
    }
}
