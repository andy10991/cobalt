import mime from "mime";
import LibAV, { type LibAV as LibAVInstance, type Packet, type Stream } from "@imput/libav.js-encode-cli";
import type { Chunk, ChunkMetadata, Decoder, FFmpegProgressCallback, FFmpegProgressEvent, FFmpegProgressStatus, FileInfo, OutputStream, RenderingPipeline, RenderParams } from "../types/libav";
import type { FfprobeData } from "fluent-ffmpeg";
import * as LibAVWebCodecs from "libavjs-webcodecs-bridge";
import { BufferStream } from "../buffer-stream";
import WebCodecsWrapper from "./webcodecs";

const QUEUE_THRESHOLD_MIN = 16;
const QUEUE_THRESHOLD_MAX = 128;

export default class LibAVWrapper {
    libav: Promise<LibAVInstance> | null;
    webcodecs: WebCodecsWrapper | null;
    concurrency: number;
    onProgress?: FFmpegProgressCallback;

    constructor(onProgress?: FFmpegProgressCallback) {
        this.libav = null;
        this.webcodecs = null;
        this.concurrency = Math.min(4, navigator.hardwareConcurrency);
        this.onProgress = onProgress;
    }

    async init() {
        if (!this.libav) {
            this.libav = LibAV.LibAV({
                yesthreads: true,
                base: '/_libav'
            });

            this.webcodecs = new WebCodecsWrapper(await this.libav);
        }
    }

    async #get() {
        if (!this.libav) throw new Error("LibAV wasn't initialized");
        if (!this.webcodecs) throw new Error("unreachable");

        return {
            libav: await this.libav,
            webcodecs: this.webcodecs
        };
    }

    async probe(blob: Blob) {
        const { libav } = await this.#get();

        const OUT_FILE = 'output.json';
        await libav.mkreadaheadfile('input', blob);
        await libav.mkwriterdev(OUT_FILE);

        let writtenData = new Uint8Array(0);

        libav.onwrite = (name, pos, data) => {
            if (name !== OUT_FILE) return;

            const newLen = Math.max(pos + data.length, writtenData.length);
            if (newLen > writtenData.length) {
                const newData = new Uint8Array(newLen);
                newData.set(writtenData);
                writtenData = newData;
            }
            writtenData.set(data, pos);
        };

        await libav.ffprobe([
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            'input',
            '-o', OUT_FILE
        ]);

        await libav.unlink(OUT_FILE);
        await libav.unlinkreadaheadfile('input');

        const copy = new Uint8Array(writtenData);
        const text = new TextDecoder().decode(copy);
        return JSON.parse(text) as FfprobeData;
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

    async remux({ blob, output, args }: RenderParams) {
        const { libav } = await this.#get();

        const inputKind = blob.type.split("/")[0];
        const inputExtension = LibAVWrapper.getExtensionFromType(blob);

        if (inputKind !== "video" && inputKind !== "audio") return;
        if (!inputExtension) return;

        const input: FileInfo = {
            kind: inputKind,
            extension: inputExtension,
        }

        if (!output) output = input;

        output.type = mime.getType(output.extension);
        if (!output.type) return;

        const outputName = `output.${output.extension}`;

        await libav.mkreadaheadfile("input", blob);

        // https://github.com/Yahweasel/libav.js/blob/7d359f69/docs/IO.md#block-writer-devices
        await libav.mkwriterdev(outputName);
        await libav.mkwriterdev('progress.txt');

        // since we expect the output file to be roughly the same size
        // as the original, preallocate its size for the output
        let writtenData = new Uint8Array(blob.size), actualSize = 0;

        libav.onwrite = (name, pos, data) => {
            if (name === 'progress.txt') {
                try {
                    return this.#emitProgress(data);
                } catch(e) {
                    console.error(e);
                }
            } else if (name !== outputName) return;

            actualSize = Math.max(pos + data.length, actualSize);
            const newLen = Math.max(pos + data.length, writtenData.length);
            if (newLen > writtenData.length) {
                const newData = new Uint8Array(newLen);
                newData.set(writtenData);
                writtenData = newData;
            }
            writtenData.set(data, pos);
        };

        await libav.ffmpeg([
            '-nostdin', '-y',
            '-loglevel', 'error',
            '-progress', 'progress.txt',
            '-threads', this.concurrency.toString(),
            '-i', 'input',
            ...args,
            outputName
        ]);

        await libav.unlink(outputName);
        await libav.unlink('progress.txt');
        await libav.unlinkreadaheadfile("input");

        // if we didn't need as much space as we allocated for some reason,
        // shrink the buffer so that we don't inflate the file with zeros
        if (writtenData.length > actualSize) {
            writtenData = writtenData.slice(0, actualSize);
        }

        const renderBlob = new Blob(
            [ writtenData ],
            { type: output.type }
        );

        if (renderBlob.size === 0) return;
        return renderBlob;
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
                const {
                    pipe,
                    stream: ostream
                } = await this.#createEncoder(stream, 'avc1.64083e');

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

        for (const { decoder } of pipes) {
            await decoder.instance.flush();
            decoder.instance.close();
            decoder.output.push(null);
        }
    }

    async #encodeStream(
        frames: RenderingPipeline['decoder']['output'],
        { instance: encoder, output }: RenderingPipeline['encoder']
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
            if (value instanceof AudioData && encoder instanceof AudioEncoder) {
                encoder.encode(value);
            } else if (value instanceof VideoFrame && encoder instanceof VideoEncoder) {
                encoder.encode(value);
            }

            value.close();
        }

        await encoder.flush();
        encoder.close();
        output.push(null);
    }

    async #encodeStreams(pipes: RenderingPipeline[]) {
        return Promise.all(
            pipes.map(
                ({ decoder, encoder }) => {
                    return this.#encodeStream(decoder.output, encoder);
                }
            )
        )
    }

    async #processChunk({ chunk, metadata }: { chunk: Chunk, metadata: ChunkMetadata }, ostream: OutputStream, index: number) {
        const { libav } = await this.#get();

        let convertToPacket;
        if (chunk instanceof EncodedVideoChunk) {
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
                readers[i] = pipes[i].encoder.output.getReader();

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
                }, ostreams
            );

            await libav.avformat_write_header(output_ctx, 0);
            await libav.ff_write_multi(output_ctx, write_pkt, starterPackets);

            let writePromise = Promise.resolve();
            await Promise.all(pipes.map(async (_, i) => {
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
        let chunk;
        if (decoder instanceof VideoDecoder) {
            chunk = LibAVWebCodecs.packetToEncodedVideoChunk(packet, stream);
        } else if (decoder instanceof AudioDecoder) {
            chunk = LibAVWebCodecs.packetToEncodedAudioChunk(packet, stream);
        }

        decoder.decode(chunk);
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
        const { libav } = await this.#get();

        let streamToConfig, configToStream, Encoder;

        if (stream.codec_type === libav.AVMEDIA_TYPE_VIDEO) {
            streamToConfig = LibAVWebCodecs.videoStreamToConfig;
            configToStream = LibAVWebCodecs.configToVideoStream;
            Encoder = VideoEncoder;
        } else if (stream.codec_type === libav.AVMEDIA_TYPE_AUDIO) {
            streamToConfig = LibAVWebCodecs.audioStreamToConfig;
            configToStream = LibAVWebCodecs.configToAudioStream;
            Encoder = AudioEncoder;
            codec = 'mp4a.40.29';
        } else throw "Unknown type: " + stream.codec_type;

        const config = await streamToConfig(libav, stream);
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

        let { supported } = await Encoder.isConfigSupported(encoderConfig);
        if (!supported) {
            throw "cannot encode " + codec;
        }

        const output = new BufferStream<
            { chunk: Chunk, metadata: ChunkMetadata }
        >();

        const encoder = new Encoder({
            output: (chunk, metadata = {}) => {
                output.push({ chunk, metadata })
            },
            error: console.error
        });

        encoder.configure(encoderConfig);

        const c2s = await configToStream(libav, encoderConfig);

        // FIXME: figure out a proper way to handle timescale
        //        (preferrably without killing self)
        c2s[1] = 1;
        c2s[2] = 60000;

        return {
            pipe: { instance: encoder, output },
            stream: c2s
        };
    }

    async #createDecoder(stream: Stream) {
        const { libav } = await this.#get();

        let streamToConfig, initDecoder;

        if (stream.codec_type === libav.AVMEDIA_TYPE_VIDEO) {
            streamToConfig = LibAVWebCodecs.videoStreamToConfig;
            initDecoder = this.webcodecs.initVideoDecoder;
        } else if (stream.codec_type === libav.AVMEDIA_TYPE_AUDIO) {
            streamToConfig = LibAVWebCodecs.audioStreamToConfig;
            initDecoder = this.webcodecs.initAudioDecoder;
        } else throw "Unknown type: " + stream.codec_type;

        const config = await streamToConfig(libav, stream);

        if (config === null) {
            throw "could not make decoder config";
        }

        let { supported } = await Decoder.isConfigSupported(config);
        if (!supported) {
            throw "cannot decode " + config.codec;
        }

        const output = new BufferStream<VideoFrame | AudioData>();
        const decoder = new Decoder({
            output: frame => output.push(frame),
            error: console.error
        });

        decoder.configure(config);
        return { instance: decoder, output }
    }

    #emitProgress(data: Uint8Array | Int8Array) {
        if (!this.onProgress) return;

        const copy = new Uint8Array(data);
        const text = new TextDecoder().decode(copy);
        const entries = Object.fromEntries(
            text.split('\n')
                .filter(a => a)
                .map(a => a.split('=', ))
        );

        const status: FFmpegProgressStatus = (() => {
            const { progress } = entries;

            if (progress === 'continue' || progress === 'end') {
                return progress;
            }

            return "unknown";
        })();

        const tryNumber = (str: string, transform?: (n: number) => number) => {
            if (str) {
                const num = Number(str);
                if (!isNaN(num)) {
                    if (transform)
                        return transform(num);
                    else
                        return num;
                }
            }
        }

        const progress: FFmpegProgressEvent = {
            status,
            frame: tryNumber(entries.frame),
            fps: tryNumber(entries.fps),
            total_size: tryNumber(entries.total_size),
            dup_frames: tryNumber(entries.dup_frames),
            drop_frames: tryNumber(entries.drop_frames),
            speed: tryNumber(entries.speed?.trim()?.replace('x', '')),
            out_time_sec: tryNumber(entries.out_time_us, n => Math.floor(n / 1e6))
        };

        this.onProgress(progress);
    }
}