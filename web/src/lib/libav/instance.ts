import mime from "mime";
import LibAV, { type LibAV as LibAVInstance } from "@imput/libav.js-remux-cli";

export default class LibAVWrapper {
    #libav__constructor: typeof LibAV;
    #libav: Promise<LibAVInstance> | null;
    #useThreads: boolean;
    concurrency: number;

    constructor(ctor: typeof LibAV, threads = true) {
        this.#libav = null;
        this.#useThreads = threads;
        this.#libav__constructor = ctor;
        this.concurrency = Math.min(4, navigator.hardwareConcurrency);
    }

    async init() {
        if (!this.#libav) {
            this.#libav = this.#libav__constructor.LibAV({
                yesthreads: this.#useThreads,
                base: '/_libav'
            });
        }
    }

    protected async get() {
        if (!this.#libav) throw new Error("LibAV wasn't initialized");

        return {
            libav: await this.#libav
        };
    }

    static getExtensionFromType(blob: Blob) {
        const extensions = mime.getAllExtensions(blob.type);
        const overrides = ['mp3', 'mov'];

        if (!extensions)
            return;

        for (const override of overrides)
            if (extensions?.has(override))
                return override;

        return [...extensions][0];
    }

}