import LibAV, { type Packet, type Stream } from "@imput/libav.js-encode-cli";
import type { Chunk, ChunkMetadata, Decoder, OutputStream, Pipeline, RenderingPipeline } from "../types/libav";
import * as LibAVWebCodecs from "@imput/libavjs-webcodecs-bridge";
import { BufferStream } from "../buffer-stream";
import WebCodecsWrapper from "./webcodecs";
import LibAVWrapper from "./instance";
import {
    EncodedAudioChunk as PolyfilledEncodedAudioChunk,
    EncodedVideoChunk as PolyfilledEncodedVideoChunk
} from "@imput/libavjs-webcodecs-polyfill";

const QUEUE_THRESHOLD_MIN = 16;
const QUEUE_THRESHOLD_MAX = 128;

export default class EncodeLibAV extends LibAVWrapper {
    webcodecs: WebCodecsWrapper | null = null;

    constructor() {
        super(LibAV);
    }

    async init() {
        await super.init();
        if (!this.webcodecs) {
            this.webcodecs = new WebCodecsWrapper(
                super.get().then(({ libav }) => libav)
            );
        }
    }

    async #get() {
        return {
            ...await super.get(),
            webcodecs: this.webcodecs!
        };
    }

    async transcode(blob: Blob) {
        const { libav } = await this.#get();
        let fmtctx;

        await libav.mkreadaheadfile('input', blob);
        try {
            const [ fmt_ctx, streams ] = await libav.ff_init_demuxer_file('input');
            fmtctx = fmt_ctx;

            const pipes: RenderingPipeline[] = [];
            const output_streams: OutputStream[] = [];
            for (const stream of streams) {
                // FIXME: support images.
                if (stream.codec_id === 61 || stream.codec_id === 62) {
                    pipes.push(null);
                    output_streams.push(null);
                    continue;
                }

                const {
                    pipe,
                    stream: ostream
                } = await this.#createEncoder(stream, 'flac');

                pipes.push({
                    decoder: await this.#createDecoder(stream),
                    encoder: pipe
                } as RenderingPipeline);
                output_streams.push(ostream);
            }

            await Promise.all([
                this.#decodeStreams(fmt_ctx, pipes, streams),
                this.#encodeStreams(pipes),
                this.#mux(pipes, output_streams)
            ])
        } catch(e) {
            console.error(e);
        } finally {
            await libav.unlinkreadaheadfile('input');

            if (fmtctx) {
                await libav.avformat_close_input_js(fmtctx);
            }
        }
    }

    async #decodeStreams(fmt_ctx: number, pipes: RenderingPipeline[], streams: Stream[]) {
        for await (const { index, packet } of this.#demux(fmt_ctx)) {
            if (pipes[index] === null) continue;

            const { decoder } = pipes[index];

            this.#decodePacket(decoder.instance, packet, streams[index]);

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
                await pipe.decoder.instance.flush();
                pipe.decoder.instance.close();
                pipe.decoder.output.push(null);
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
                console.log(value);
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
            .filter(p => p !== null)
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

    async #mux(pipes: RenderingPipeline[], ostreams: OutputStream[]) {
        const { libav } = await this.#get();
        const write_pkt = await libav.av_packet_alloc();

        let writer_ctx = 0, output_ctx = 0;

        try {
            const starterPackets = [], readers: ReadableStreamDefaultReader[] = [];

            for (let i = 0; i < ostreams.length; ++i) {
                if (pipes[i] === null) continue;
                readers[i] = pipes[i]!.encoder.output.getReader();

                const { done, value } = await readers[i].read();
                if (done) throw "this should not happen";

                starterPackets.push(
                    await this.#processChunk(value, ostreams[i], i)
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

            await libav.mkwriterdev("output.mp4");
            [ output_ctx,, writer_ctx ] = await libav.ff_init_muxer(
                {
                    format_name: 'mp4',
                    filename: 'output.mp4',
                    device: true,
                    open: true,
                    codecpars: true
                }, ostreams.filter(a => a !== null)
            );

            await libav.avformat_write_header(output_ctx, 0);
            await libav.ff_write_multi(output_ctx, write_pkt, starterPackets);

            let writePromise = Promise.resolve();
            await Promise.all(pipes.map(async (pipe, i) => {
                if (pipe === null) {
                    return;
                }

                while (true) {
                    const { done, value } = await readers[i].read();
                    if (done) break;

                    writePromise = writePromise.then(async () => {
                        const packet = await this.#processChunk(value, ostreams[i], i);
                        await libav.ff_write_multi(output_ctx, write_pkt, [ packet ]);
                    });
                }
            }));

            await writePromise;
            await libav.av_write_trailer(output_ctx);

            const renderBlob = new Blob(
                [ writtenData ],
                { type: "video/mp4" }
            );

            window.open(URL.createObjectURL(renderBlob), '_blank');
        } finally {
            try {
                await libav.unlink('output.mp4');
            } catch {}

            await libav.av_packet_free(write_pkt);
            if (output_ctx && writer_ctx) {
                await libav.ff_free_muxer(output_ctx, writer_ctx);
            }
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

    async* #demux(fmt_ctx: number) {
        const { libav } = await this.#get();
        const read_pkt = await libav.av_packet_alloc();

        try {
            while (true) {
                const [ ret, packets ] = await libav.ff_read_frame_multi(fmt_ctx, read_pkt, { limit: 1 });

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

    async #createEncoder(stream: Stream, codec: string) {
        const { libav, webcodecs } = await this.#get();

        let streamToConfig, configToStream, initEncoder;

        if (stream.codec_type === libav.AVMEDIA_TYPE_VIDEO) {
            streamToConfig = LibAVWebCodecs.videoStreamToConfig;
            configToStream = LibAVWebCodecs.configToVideoStream;
            initEncoder = webcodecs.initVideoEncoder.bind(webcodecs);
        } else if (stream.codec_type === libav.AVMEDIA_TYPE_AUDIO) {
            streamToConfig = LibAVWebCodecs.audioStreamToConfig;
            configToStream = LibAVWebCodecs.configToAudioStream;
            initEncoder = webcodecs.initAudioEncoder.bind(webcodecs);
        } else throw "Unknown type: " + stream.codec_type;

        const config = await streamToConfig(libav, stream, true);
        if (config === null) {
            throw "could not make encoder config";
        }

        const encoderConfig = {
            codec,
            width: config.codedWidth,
            height: config.codedHeight,
            numberOfChannels: config.numberOfChannels,
            sampleRate: config.sampleRate
        };


        const output = new BufferStream<
            { chunk: Chunk, metadata: ChunkMetadata }
        >();

        const encoder = await initEncoder(encoderConfig, {
            output: (chunk, metadata = {}) => {
                output.push({ chunk, metadata })
            },
            error: console.error
        });

        if (!encoder) {
            throw "cannot encode " + codec;
        }

        const encoderStream = await configToStream(libav, encoderConfig);

        return {
            pipe: { instance: encoder, output },
            stream: encoderStream
        };
    }

    async #createDecoder(stream: Stream) {
        const { libav, webcodecs } = await this.#get();

        let streamToConfig, initDecoder;

        if (stream.codec_type === libav.AVMEDIA_TYPE_VIDEO) {
            streamToConfig = LibAVWebCodecs.videoStreamToConfig;
            initDecoder = webcodecs.initVideoDecoder.bind(webcodecs);
        } else if (stream.codec_type === libav.AVMEDIA_TYPE_AUDIO) {
            streamToConfig = LibAVWebCodecs.audioStreamToConfig;
            initDecoder = webcodecs.initAudioDecoder.bind(webcodecs);
        } else throw "Unknown type: " + stream.codec_type;

        const config = await streamToConfig(libav, stream, true);

        if (config === null) {
            throw "could not make decoder config";
        }

        const output = new BufferStream<VideoFrame | AudioData>();
        const decoder = await initDecoder(config, {
            output: frame => output.push(frame),
            error: console.error
        });

        if (!decoder) {
            throw "cannot decode " + config.codec;
        }

        return { instance: decoder, output }
    }
}