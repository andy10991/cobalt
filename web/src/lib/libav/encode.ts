import LibAV, { type Packet, type Stream } from "@imput/libav.js-encode-cli";
import type { Chunk, ChunkMetadata, Decoder, DecoderPipeline, EncoderPipeline, OutputStream, Pipeline, RenderingPipeline, StreamInfo } from "../types/libav";
import * as LibAVWebCodecs from "@imput/libavjs-webcodecs-bridge";
import { BufferStream } from "../buffer-stream";
import WebCodecsWrapper from "./webcodecs";
import LibAVWrapper from "./instance";
import {
    EncodedAudioChunk as PolyfilledEncodedAudioChunk,
    EncodedVideoChunk as PolyfilledEncodedVideoChunk
} from "@imput/libavjs-webcodecs-polyfill";
import type { AudioEncoderConfig, VideoEncoderConfig } from "@imput/libavjs-webcodecs-polyfill";
import { probeAudio, probeVideo, type ProbeResult } from "./probe";

const QUEUE_THRESHOLD_MIN = 16;
const QUEUE_THRESHOLD_MAX = 128;

export default class EncodeLibAV extends LibAVWrapper {
    #webcodecs: WebCodecsWrapper | null = null;
    #has_file = false;
    #fmt_ctx?: number;

    #istreams?: Stream[];
    #decoders?: DecoderPipeline[];

    #encoders?: EncoderPipeline[];
    #ostreams?: OutputStream[];
    #passthrough?: (BufferStream<Packet> | null)[];

    constructor() {
        super(LibAV);
    }

    async init() {
        await super.init();
        if (!this.#webcodecs) {
            this.#webcodecs = new WebCodecsWrapper(
                super.get().then(({ libav }) => libav)
            );

            await this.#webcodecs.load();
        }
    }

    async #get() {
        return {
            ...await super.get(),
            webcodecs: this.#webcodecs!
        };
    }

    async cleanup() {
        const { libav } = await this.#get();

        if (this.#has_file) {
            await libav.unlinkreadaheadfile('input');
            this.#has_file = false;
        }

        if (this.#fmt_ctx) {
            await libav.avformat_close_input_js(this.#fmt_ctx);
            this.#fmt_ctx = undefined;
            this.#istreams = undefined;
        }

        if (this.#encoders) {
            for (const encoder of this.#encoders) {
                try {
                    encoder?.instance.close();
                } catch {}
            }
            this.#encoders = undefined;
        }

        if (this.#decoders) {
            for (const decoder of this.#decoders) {
                try {
                    decoder?.instance.close();
                } catch {}
            }
            this.#decoders = undefined;
        }
    }

    async feed(blob: Blob) {
        if (this.#has_file) {
            throw "readahead file already exists";
        }

        const { libav } = await this.#get();

        await libav.mkreadaheadfile('input', blob);
        this.#has_file = true;

        try {
            const [ fmt_ctx, streams ] = await libav.ff_init_demuxer_file('input');
            this.#fmt_ctx = fmt_ctx;
            this.#istreams = streams;
        } catch(e) {
            await this.cleanup();
        }
    }

    async prep() {
        if (!this.#istreams || !this.#fmt_ctx) {
            throw "streams are not set up";
        } else if (this.#decoders) {
            throw "decoders are already set up";
        }

        this.#decoders    = Array(this.#istreams.length).fill(null);
        this.#encoders    = Array(this.#istreams.length).fill(null);
        this.#ostreams    = Array(this.#istreams.length).fill(null);
        this.#passthrough = Array(this.#istreams.length).fill(null);

        for (const idx in this.#istreams) {
            try {
                this.#decoders[idx] = await this.#createDecoder(
                    this.#istreams[idx]
                )
            } catch(e) {
                console.error('could not make decoder', e);
            }
        }
    }

    async getStreamInfo(): Promise<StreamInfo[]> {
        if (!this.#istreams) {
            throw "input not configured";
        } else if (!this.#decoders) {
            throw "decoders not prepped";
        }

        const { libav } = await this.#get();

        return Promise.all(this.#istreams.map(
            async (stream, index) => {
                const codec = await libav.avcodec_get_name(stream.codec_id);

                let type = 'unsupported';
                if (stream.codec_type === libav.AVMEDIA_TYPE_VIDEO) {
                    type = 'video'
                } else if (stream.codec_type === libav.AVMEDIA_TYPE_AUDIO) {
                    type = 'audio'
                }

                const decoderConfig: VideoDecoderConfig | AudioDecoderConfig = await this.#streamToConfig(stream);
                const config = {
                    ...decoderConfig,
                    width: 'codedWidth' in decoderConfig ? decoderConfig.codedWidth : undefined,
                    height: 'codedHeight' in decoderConfig ? decoderConfig.codedHeight : undefined,
                };

                let output: ProbeResult = {};
                if (type === 'video') {
                    output = await probeVideo(config as globalThis.VideoEncoderConfig);
                } else if (type === 'audio') {
                    output = await probeAudio(config as globalThis.AudioEncoderConfig)
                }

                return {
                    codec,
                    type,
                    supported: !!this.#decoders?.[index],
                    output
                }
            }
        ));
    }

    async configureEncoder(index: number, config: AudioEncoderConfig | VideoEncoderConfig | "passthrough" | null) {
        if (!this.#istreams || !this.#ostreams || !this.#istreams[index])
            throw "stream does not exist or streams are not configured"
        else if (!this.#encoders || !this.#passthrough)
            throw "decoders have not been set up yet";

        const { libav, webcodecs } = await this.#get();
        const stream = this.#istreams[index];

        let configToStream, initEncoder;

        if (config === 'passthrough') {
            this.#passthrough[index] = new BufferStream();
            this.#ostreams[index] = [ stream.codecpar, stream.time_base_num, stream.time_base_den ];
            return true;
        } else {
            this.#passthrough[index] = null;
        }

        if (this.#encoders[index]) {
            await this.#encoders[index].instance.flush();
            this.#encoders[index].instance.close();
            this.#encoders[index] = null;
        }

        if (config === null) {
            return true;
        }

        if (stream.codec_type === libav.AVMEDIA_TYPE_VIDEO) {
            configToStream = LibAVWebCodecs.configToVideoStream;
            initEncoder = webcodecs.initVideoEncoder.bind(webcodecs);
        } else if (stream.codec_type === libav.AVMEDIA_TYPE_AUDIO) {
            configToStream = LibAVWebCodecs.configToAudioStream;
            initEncoder = webcodecs.initAudioEncoder.bind(webcodecs);
        } else throw "Unknown type: " + stream.codec_type;

        const output = new BufferStream<
            { chunk: Chunk, metadata: ChunkMetadata }
        >();

        const encoder = await initEncoder(config as any /* fixme */, {
            output: (chunk, metadata = {}) => {
                output.push({ chunk, metadata })
            },
            error: console.error
        });

        if (!encoder) {
            return false;
        }

        this.#ostreams[index] = await configToStream(libav, config);
        this.#encoders[index] = { instance: encoder, output } as EncoderPipeline;

        return true;
    }

    async work(formatName: string) {
        if (!this.#encoders || !this.#decoders)
            throw "not configured";

        const pipes: RenderingPipeline[] = Array(this.#decoders.length).fill(null);
        for (let i = 0; i < this.#encoders.length; ++i) {
            if (this.#passthrough && this.#passthrough[i] !== null) {
                pipes[i] = {
                    type: 'passthrough',
                    output: this.#passthrough[i]!
                };
                continue;
            } else if (this.#encoders[i] === null) continue;
            else if (this.#decoders[i] === null) continue;

            pipes[i] = {
                encoder: this.#encoders[i],
                decoder: this.#decoders[i]
            } as RenderingPipeline;
        }

        const [,, blob] = await Promise.all([
            this.#decodeStreams(pipes),
            this.#encodeStreams(pipes),
            this.#mux(pipes, formatName)
        ]);

        return blob;
    }

    async #decodeStreams(pipes: RenderingPipeline[]) {
        if (!this.#istreams) throw "istreams are not set up";

        for await (const { index, packet } of this.#demux()) {
            if (pipes[index] === null) {
                continue;
            } else if ('type' in pipes[index] && pipes[index].type === 'passthrough') {
                pipes[index].output.push(packet);
                continue;
            }

            const { decoder } = pipes[index] as Pipeline;

            this.#decodePacket(decoder.instance, packet, this.#istreams[index]);

            let currentSize = decoder.instance.decodeQueueSize + decoder.output.queue.size;
            if (currentSize >= QUEUE_THRESHOLD_MAX) {
                while (currentSize > QUEUE_THRESHOLD_MIN) {
                    await new Promise(res => {
                        if (decoder.instance.decodeQueueSize)
                            decoder.instance.addEventListener("dequeue", res, { once: true });
                        else
                            setTimeout(res, 100);
                    });
                    currentSize = decoder.instance.decodeQueueSize + decoder.output.queue.size;
                }
            }
        }

        for (const pipe of pipes) {
            if (pipe !== null) {
                if ('type' in pipe && pipe.type === 'passthrough') {
                    pipe.output.push(null);
                } else {
                    const _pipe = pipe as Pipeline;
                    await _pipe.decoder.instance.flush();
                    _pipe.decoder.instance.close();
                    _pipe.decoder.output.push(null);
                }
            }
        }
    }

    async #encodeStream(
        frames: Pipeline['decoder']['output'],
        { instance: encoder, output }: Pipeline['encoder']
    ) {
        const reader = frames.getReader();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            let currentSize = encoder.encodeQueueSize + output.queue.size;

            if (currentSize >= QUEUE_THRESHOLD_MAX) {
                while (currentSize > QUEUE_THRESHOLD_MIN) {
                    await new Promise(res => {
                        if (encoder.encodeQueueSize)
                            encoder.addEventListener("dequeue", res, { once: true });
                        else
                            setTimeout(res, 100);
                    });
                    currentSize = encoder.encodeQueueSize + output.queue.size;
                }
            }

            // FIXME: figure out how to make typescript happy without this monstrosity
            if (WebCodecsWrapper.isVideo(encoder)) {
                WebCodecsWrapper.encodeVideo(
                    value as VideoFrame,
                    encoder as VideoEncoder
                );
            } else {
                WebCodecsWrapper.encodeAudio(
                    value as AudioData,
                    encoder as AudioEncoder
                );
            }

            value.close();
        }

        await encoder.flush();
        encoder.close();
        output.push(null);
    }

    async #encodeStreams(pipes: RenderingPipeline[]) {
        return Promise.all(
            pipes
            .filter(p => p !== null && !('type' in p && p.type === 'passthrough'))
            .map(p => p as Pipeline)
            .map(
                ({ decoder, encoder }) => {
                    return this.#encodeStream(decoder.output, encoder);
                }
            )
        )
    }

    async #processChunk({ chunk, metadata }: { chunk: Chunk, metadata: ChunkMetadata }, ostream: OutputStream, index: number) {
        if (ostream === null) return;
        const { libav } = await this.#get();

        let convertToPacket;
        if (WebCodecsWrapper.isVideo(chunk)) {
            convertToPacket = LibAVWebCodecs.encodedVideoChunkToPacket;
        } else {
            convertToPacket = LibAVWebCodecs.encodedAudioChunkToPacket;
        }

        return await convertToPacket(libav, chunk, metadata, ostream, index);
    }

    async #mux(pipes: RenderingPipeline[], format_name: string) {
        if (!this.#ostreams) throw "ostreams not configured";

        const ostreams = this.#ostreams;
        const { libav } = await this.#get();
        const write_pkt = await libav.av_packet_alloc();

        let writer_ctx = 0, output_ctx = 0;

        try {
            const starterPackets = [], readers: ReadableStreamDefaultReader[] = [];

            for (let i = 0; i < ostreams.length; ++i) {
                const pipe = pipes[i];
                if (pipe === null) continue;
                const isPassthrough = 'type' in pipe && pipe.type === 'passthrough';

                if (isPassthrough) {
                    readers[i] = pipe.output.getReader();
                } else {
                    readers[i] = (pipe as Pipeline).encoder.output.getReader();
                }

                const { done, value } = await readers[i].read();
                if (done) throw "this should not happen";

                starterPackets.push(
                    isPassthrough ? value : await this.#processChunk(value, ostreams[i], i)
                );
            }

            let writtenData = new Uint8Array(0);
            libav.onwrite = (_, pos, data) => {
                const newLen = Math.max(pos + data.length, writtenData.length);
                if (newLen > writtenData.length) {
                    const newData = new Uint8Array(newLen);
                    newData.set(writtenData);
                    writtenData = newData;
                }

                writtenData.set(data, pos);
            };

            await libav.mkwriterdev("output");
            [ output_ctx,, writer_ctx ] = await libav.ff_init_muxer(
                {
                    format_name,
                    filename: 'output',
                    device: true,
                    open: true,
                    codecpars: true
                }, this.#ostreams.filter(a => a !== null)
            );

            await libav.avformat_write_header(output_ctx, 0);
            await libav.ff_write_multi(output_ctx, write_pkt, starterPackets);

            let writePromise = Promise.resolve();
            await Promise.all(pipes.map(async (pipe, i) => {
                if (pipe === null) {
                    return;
                }
                const isPassthrough = 'type' in pipe && pipe.type === 'passthrough';

                while (true) {
                    const { done, value } = await readers[i].read();
                    if (done) break;

                    writePromise = writePromise.then(async () => {
                        const packet = isPassthrough ? value : await this.#processChunk(value, ostreams[i], i);
                        await libav.ff_write_multi(output_ctx, write_pkt, [ packet ]);
                    });
                }
            }));

            await writePromise;
            await libav.av_write_trailer(output_ctx);

            return new Blob([ writtenData ]);
        } finally {
            try {
                await libav.unlink('output');
            } catch {}

            await libav.av_packet_free(write_pkt);
            if (output_ctx && writer_ctx) {
                await libav.ff_free_muxer(output_ctx, writer_ctx);
            }

            await this.cleanup();
        }
    }

    #decodePacket(decoder: Decoder, packet: Packet, stream: Stream) {
        let decoderType;

        if (decoderType = WebCodecsWrapper.isVideo(decoder)) {
            const EncodedVideoChunk = decoderType === 'polyfilled' ? PolyfilledEncodedVideoChunk : window.EncodedVideoChunk;
            WebCodecsWrapper.decodeVideo(
                LibAVWebCodecs.packetToEncodedVideoChunk(
                    packet, stream, { EncodedVideoChunk }
                ),
                decoder as VideoDecoder
            );
        } else if (decoderType = WebCodecsWrapper.isAudio(decoder)) {
            const EncodedAudioChunk = decoderType === 'polyfilled' ? PolyfilledEncodedAudioChunk : window.EncodedAudioChunk;
            WebCodecsWrapper.decodeAudio(
                LibAVWebCodecs.packetToEncodedAudioChunk(
                    packet, stream, { EncodedAudioChunk }
                ),
                decoder as AudioDecoder,
            );
        }
    }

    async* #demux() {
        if (!this.#fmt_ctx) throw "fmt_ctx is missing";
        const { libav } = await this.#get();
        const read_pkt = await libav.av_packet_alloc();

        try {
            while (true) {
                const [ ret, packets ] = await libav.ff_read_frame_multi(this.#fmt_ctx, read_pkt, { limit: 1 });

                if (ret !== -libav.EAGAIN &&
                    ret !== 0 &&
                    ret !== libav.AVERROR_EOF) {
                    break;
                }

                for (const index in packets) {
                    for (const packet of packets[index]) {
                        yield { index: Number(index), packet };
                    }
                }

                if (ret === libav.AVERROR_EOF)
                    break;
            }
        } finally {
            await libav.av_packet_free(read_pkt);
        }
    }

    #streamToConfig(stream: Stream) {
        let _streamToConfig;

        if (stream.codec_type === LibAV.AVMEDIA_TYPE_VIDEO) {
            _streamToConfig = LibAVWebCodecs.videoStreamToConfig;
        } else if (stream.codec_type === LibAV.AVMEDIA_TYPE_AUDIO) {
            _streamToConfig = LibAVWebCodecs.audioStreamToConfig;
        } else throw "Unknown type: " + stream.codec_type;

        return this.#get().then(
            ({ libav }) => _streamToConfig(libav, stream, true)
        ) as Promise<AudioDecoderConfig | VideoDecoderConfig>;
    }

    streamIndexToConfig(index: number) {
        if (!this.#istreams || !this.#istreams[index])
            throw "invalid stream";
        return this.#streamToConfig(this.#istreams[index]);
    }

    async #createDecoder(stream: Stream) {
        const { libav, webcodecs } = await this.#get();

        let initDecoder;

        if (stream.codec_type === libav.AVMEDIA_TYPE_VIDEO) {
            initDecoder = webcodecs.initVideoDecoder.bind(webcodecs);
        } else if (stream.codec_type === libav.AVMEDIA_TYPE_AUDIO) {
            initDecoder = webcodecs.initAudioDecoder.bind(webcodecs);
        } else throw "Unknown type: " + stream.codec_type;

        const config = await this.#streamToConfig(stream);

        if (config === null) {
            throw "could not make decoder config";
        }

        const output = new BufferStream<VideoFrame | AudioData>();
        const decoder = await initDecoder(config as any /* fixme */, {
            output: frame => output.push(frame),
            error: console.error
        });

        if (!decoder) {
            throw "cannot decode " + config.codec;
        }

        return { instance: decoder, output } as DecoderPipeline;
    }
}