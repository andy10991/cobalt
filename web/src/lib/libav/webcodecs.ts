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
                polyfill: true,
                LibAV: { LibAV: () => this.#libav }
            });
        }

        await this.#ready;
    }

    // FIXME: save me generics. generics save me
    async #getDecoder(config: VideoDecoderConfig | AudioDecoderConfig) {
        if (has(config, 'numberOfChannels') && has(config, 'sampleRate')) {
            const audioConfig = config as AudioDecoderConfig;
            for (const source of [ window, LibAVPolyfill ]) {
                if (source === LibAVPolyfill) {
                    await this.#load();
                }

                try {
                    const { supported } = await source.AudioDecoder.isConfigSupported(audioConfig);
                    if (supported) return source.AudioDecoder;
                } catch(e) {
                    console.error('AudioDecoder missing or does not support', config);
                    console.error(e);
                }
            }
        } else {
            const videoConfig = config as VideoDecoderConfig;
            for (const source of [ window, LibAVPolyfill ]) {
                if (source === LibAVPolyfill) {
                    await this.#load();
                }

                try {
                    const { supported } = await source.VideoDecoder.isConfigSupported(videoConfig);
                    if (supported) return source.VideoDecoder;
                } catch(e) {
                    console.error('VideoDecoder missing or does not support', config);
                    console.error(e);
                }
            }
        }

        return null;
    }

    async #getEncoder(config: VideoEncoderConfig | AudioEncoderConfig) {
        if (has(config, 'numberOfChannels') && has(config, 'sampleRate')) {
            const audioConfig = config as AudioEncoderConfig;
            for (const source of [ window, LibAVPolyfill ]) {
                if (source === LibAVPolyfill) {
                    await this.#load();
                }

                try {
                    const { supported } = await source.AudioEncoder.isConfigSupported(audioConfig);
                    if (supported) return source.AudioEncoder;
                } catch(e) {
                    console.error('AudioEncoder missing or does not support', config);
                    console.error(e);
                }
            }
        } else if (has(config, 'width') && has(config, 'height')) {
            const videoConfig = config as VideoEncoderConfig;
            for (const source of [ window, LibAVPolyfill ]) {
                if (source === LibAVPolyfill) {
                    await this.#load();
                }

                try {
                    const { supported } = await source.VideoEncoder.isConfigSupported(videoConfig);
                    if (supported) return source.VideoEncoder;
                } catch(e) {
                    console.error('VideoEncoder missing or does not support', config);
                    console.error(e);
                }
            }
        } else throw new Error("unreachable");

        return null;
    }

    // FIXME: this is nasty, but whatever
    async initAudioEncoder(config: AudioEncoderConfig, init: AudioEncoderInit) {
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

    static encodeAudio(data: AudioData | LibAVPolyfill.AudioData, destination: AudioEncoder) {
        const hasAudioData = 'AudioData' in window;
        const isPolyfilled = hasAudioData && window.AudioData === LibAVPolyfill.AudioData;

        if (destination instanceof LibAVPolyfill.AudioEncoder) {
            if (hasAudioData && !isPolyfilled && data instanceof AudioData) {
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

    static encodeVideo(data: VideoFrame | LibAVPolyfill.VideoFrame, destination: VideoEncoder) {
        const hasVideoFrame = 'VideoFrame' in window;
        const isPolyfilled = hasVideoFrame && VideoFrame === LibAVPolyfill.VideoFrame;

        if (destination instanceof LibAVPolyfill.VideoEncoder) {
            if (hasVideoFrame && !isPolyfilled && data instanceof VideoFrame) {
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