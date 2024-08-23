import type { LibAV } from "@imput/libav.js-encode-cli";
import * as LibAVPolyfill from "@imput/libavjs-webcodecs-polyfill";

const has = <T extends object>(obj: T, key: string) => {
    return key in obj && typeof (obj as Record<string, unknown>)[key] !== 'undefined';
}

export default class WebCodecsWrapper {
    #libav: Promise<LibAV>;
    #ready?: Promise<void>;

    constructor(libav: Promise<LibAV>) {
        this.#libav = libav;
    }

    async #load() {
        if (typeof this.#ready === 'undefined') {
            this.#ready = LibAVPolyfill.load({
                polyfill: false,
                LibAV: { LibAV: () => this.#libav }
            });
        }

        await this.#ready;
    }
    async #getDecoder(config: VideoDecoderConfig | AudioDecoderConfig) {
        if (has(config, 'numberOfChannels') && has(config, 'sampleRate')) {
            const audioConfig = config as AudioDecoderConfig;

            if ('AudioDecoder' in window && await window.AudioDecoder.isConfigSupported(audioConfig))
                return window.AudioDecoder;

            await this.#load();
            if (await LibAVPolyfill.AudioDecoder.isConfigSupported(audioConfig))
                return LibAVPolyfill.AudioDecoder;
        } else {
            const videoConfig = config as VideoDecoderConfig;
            if ('VideoDecoder' in window && await window.VideoDecoder.isConfigSupported(videoConfig))
                return window.VideoDecoder;

            await this.#load();
            if (await LibAVPolyfill.VideoDecoder.isConfigSupported(videoConfig))
                return LibAVPolyfill.VideoDecoder;
        }

        return null;
    }

    async #getEncoder(config: VideoEncoderConfig | AudioEncoderConfig) {
        if (has(config, 'numberOfChannels') && has(config, 'sampleRate')) {
            const audioConfig = config as AudioEncoderConfig;
            if ('AudioEncoder' in window && await window.AudioEncoder.isConfigSupported(audioConfig))
                return window.AudioEncoder;

            await this.#load();
            if (await LibAVPolyfill.AudioEncoder.isConfigSupported(audioConfig))
                return LibAVPolyfill.AudioEncoder;
        } else if (has(config, 'width') && has(config, 'height')) {
            const videoConfig = config as VideoEncoderConfig;
            if ('VideoEncoder' in window && await window.VideoEncoder.isConfigSupported(videoConfig))
                return window.VideoEncoder;

            await this.#load();
            if (await LibAVPolyfill.VideoEncoder.isConfigSupported(videoConfig))
                return LibAVPolyfill.VideoEncoder;
        } else throw new Error("unreachable");

        return null;
    }

    // FIXME: this is nasty, but whatever
    async initAudioEncoder(config: AudioEncoderConfig, init: AudioEncoderInit) {
        console.log(this);
        const Encoder = await this.#getEncoder(config) as typeof AudioEncoder | null;
        if (Encoder === null) return null;

        const encoder = new Encoder(init);
        encoder.configure(config);

        return encoder;
    }

    async initAudioDecoder(config: AudioDecoderConfig, init: AudioDecoderInit) {
        const Decoder = await this.#getDecoder(config) as typeof AudioDecoder | null;
        if (Decoder === null) return null;

        const decoder = new Decoder(init);
        decoder.configure(config);

        return decoder;
    }

    async initVideoEncoder(config: VideoEncoderConfig, init: VideoEncoderInit) {
        const Encoder = await this.#getEncoder(config) as typeof VideoEncoder | null;
        if (Encoder === null) return null;

        const encoder = new Encoder(init);
        encoder.configure(config);

        return encoder;
    }

    async initVideoDecoder(config: VideoDecoderConfig, init: VideoDecoderInit) {
        const Decoder = await this.#getDecoder(config) as typeof VideoDecoder | null;
        if (Decoder === null) return null;

        const decoder = new Decoder(init);
        decoder.configure(config);

        return decoder;
    }

    static isVideo(obj: unknown) {
        return ('VideoEncoder' in window && obj instanceof VideoEncoder)
                || ('VideoDecoder' in window && obj instanceof VideoDecoder)
                || ('VideoFrame' in window && obj instanceof VideoFrame)
                || ('EncodedVideoChunk' in window && obj instanceof EncodedVideoChunk)
                || obj instanceof LibAVPolyfill.VideoEncoder
                || obj instanceof LibAVPolyfill.VideoDecoder
                || obj instanceof LibAVPolyfill.VideoFrame
                || obj instanceof LibAVPolyfill.EncodedVideoChunk;
    }

    static isAudio(obj: unknown) {
        return ('AudioEncoder' in window && obj instanceof AudioEncoder)
                || ('AudioDecoder' in window && obj instanceof AudioDecoder)
                || ('AudioData' in window && obj instanceof AudioData)
                || ('EncodedAudioChunk' in window && obj instanceof EncodedAudioChunk)
                || obj instanceof LibAVPolyfill.AudioEncoder
                || obj instanceof LibAVPolyfill.AudioDecoder
                || obj instanceof LibAVPolyfill.AudioData
                || obj instanceof LibAVPolyfill.EncodedAudioChunk;
    }

    static sendAudio(data: AudioData | LibAVPolyfill.AudioData, destination: AudioEncoder) {
        if (destination instanceof LibAVPolyfill.AudioEncoder) {
            if ('AudioData' in window && data instanceof AudioData) {
                const converted = LibAVPolyfill.AudioData.fromNative(data);
                data.close();
                data = converted;
            }
        } else {
            if (data instanceof LibAVPolyfill.AudioData) {
                data = data.toNative({ transfer: true });
            }
        }

        return destination.encode(data);
    }

    static sendVideo(data: VideoFrame | LibAVPolyfill.VideoFrame, destination: VideoEncoder) {
        if (destination instanceof LibAVPolyfill.VideoEncoder) {
            if ('VideoFrame' in window && data instanceof VideoFrame) {
                const converted = LibAVPolyfill.VideoFrame.fromNative(data);
                data.close();
                data = converted;
            }
        } else {
            if (data instanceof LibAVPolyfill.VideoFrame) {
                data = data.toNative({ transfer: true });
            }
        }

        return destination.encode(data as VideoFrame);
    }
}