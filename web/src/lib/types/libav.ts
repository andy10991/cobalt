import { BufferStream } from "$lib/buffer-stream";
import type { ProbeResult } from "$lib/libav/probe";

export type InputFileKind = "video" | "audio";

export type FileInfo = {
    type?: string | null,
    kind: InputFileKind,
    extension: string,
}

export type RenderParams = {
    blob: Blob,
    output?: FileInfo,
    args: string[],
}


export type FFmpegProgressStatus = "continue" | "end" | "unknown";
export type FFmpegProgressEvent = {
    status: FFmpegProgressStatus,
    frame?: number,
    fps?: number,
    total_size?: number,
    dup_frames?: number,
    drop_frames?: number,
    speed?: number,
    out_time_sec?: number,
}

export type FFmpegProgressCallback = (info: FFmpegProgressEvent) => void;
export type Decoder = VideoDecoder | AudioDecoder;
export type Encoder = VideoEncoder | AudioEncoder;

export type ChunkMetadata = EncodedVideoChunkMetadata | EncodedAudioChunkMetadata;
export type Chunk = EncodedVideoChunk | EncodedAudioChunk;

export type PipelineComponent<Transformer, Output> = {
    instance: Transformer,
    output: BufferStream<Output>
};

export type AudioDecoderPipeline = PipelineComponent<AudioDecoder, AudioData>;
export type VideoDecoderPipeline = PipelineComponent<VideoDecoder, VideoFrame>;

export type AudioEncoderPipeline = PipelineComponent<
    AudioEncoder,
    {
        chunk: EncodedAudioChunk,
        metadata: EncodedAudioChunkMetadata
    }
>;

export type VideoEncoderPipeline = PipelineComponent<
    VideoEncoder,
    {
        chunk: EncodedVideoChunk,
        metadata: EncodedVideoChunkMetadata
    }
>;

export type AudioPipeline = {
    decoder: AudioDecoderPipeline,
    encoder: AudioEncoderPipeline
};

export type VideoPipeline = {
    decoder: VideoDecoderPipeline,
    encoder: VideoEncoderPipeline
}

export type Pipeline = AudioPipeline | VideoPipeline;
export type DecoderPipeline = AudioDecoderPipeline | VideoDecoderPipeline | null;
export type EncoderPipeline = AudioEncoderPipeline | VideoEncoderPipeline | null;
export type RenderingPipeline = Pipeline | null;
export type OutputStream = [number, number, number] | null;
export type ContainerConfiguration = {
    formatName: string
};

export type StreamInfo = {
    codec: string,
    type: string,
    supported: boolean,
    output: ProbeResult
};