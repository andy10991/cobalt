import { BufferStream } from "$lib/buffer-stream";

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

export type AudioPipeline = {
    decoder: {
        instance: AudioDecoder,
        output: BufferStream<AudioData>
    },
    encoder: {
        instance: AudioEncoder,
        output: BufferStream<{
            chunk: EncodedAudioChunk,
            metadata: EncodedAudioChunkMetadata
        }>
    }
};

export type VideoPipeline = {
    decoder: {
        instance: VideoDecoder,
        output: BufferStream<VideoFrame>
    },
    encoder: {
        instance: VideoEncoder,
        output: BufferStream<{
            chunk: EncodedVideoChunk,
            metadata: EncodedVideoChunkMetadata
        }>
    }
}

export type RenderingPipeline = AudioPipeline | VideoPipeline;
export type OutputStream = [number, number, number];
