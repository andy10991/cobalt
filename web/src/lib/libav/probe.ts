import * as LibAVPolyfill from "@imput/libavjs-webcodecs-polyfill";

const AUDIO_CODECS = {
    aac: ['mp4a.40.02', 'mp4a.40.05', 'mp4a.40.29'],
    opus: ['opus'],
    mp3: ['mp3', 'mp4a.69', 'mp4a.6B'],
    flac: ['flac'],
    ogg: ['vorbis'],
    ulaw: ['ulaw'],
    alaw: ['alaw']
};

const VIDEO_CODECS = {
    h264: ['avc1.42E01E', 'avc1.42E01F', 'avc1.4D401F', 'avc1.4D4028', 'avc1.640028', 'avc1.640029', 'avc1.64002A'],
    av1: ['av01.0.08M.08', 'av01.0.12M.08', 'av01.0.16M.08'],
    vp9: ['vp09.01.10.08', 'vp09.02.10.08'],
    hevc: ['hvc1.1.6.L93.B0', 'hvc1.1.6.L123.00', 'hvc1.1.6.L153.00', 'hvc1.2.4.L93.00', 'hvc1.2.4.L123.00']
};

async function probeSingleAudio(config: AudioEncoderConfig) {
    try {
        if ('AudioEncoder' in window && window.AudioEncoder !== LibAVPolyfill.AudioEncoder) {
            const { supported } = await window.AudioEncoder.isConfigSupported(config);
            if (supported) {
                return { supported };
            }
        }
    } catch(e) { console.warn('audio native probe fail', e) }

    try {
        const { supported } = await LibAVPolyfill.AudioEncoder.isConfigSupported(config);
        if (supported) {
            return { supported, slow: true }
        }
    } catch(e) { console.warn('audio polyfill probe fail', e) }

    return { supported: false }
}

async function probeSingleVideo(config: VideoEncoderConfig) {
    try {
        if ('VideoEncoder' in window && window.VideoEncoder !== LibAVPolyfill.VideoEncoder) {
            const { supported } = await window.VideoEncoder.isConfigSupported(config);
            if (supported) {
                return { supported };
            }
        }
    } catch(e) { console.warn('video native probe fail', e) }

    try {
        const { supported } = await LibAVPolyfill.VideoEncoder.isConfigSupported(config);
        if (supported) {
            return { supported, slow: true }
        }
    } catch(e) { console.warn('video polyfill probe fail', e) }

    return { supported: false }
}

export type ProbeResult = {
    [name: string]: { supported: false } | {
        supported: true,
        codec: string,
        slow?: boolean
    }
}

export async function probeAudio(partial: Omit<AudioEncoderConfig, "codec">) {
    const result: ProbeResult = {};

    for (const [ name, codecs ] of Object.entries(AUDIO_CODECS)) {
        result[name] = { supported: false };
        for (const codec of codecs) {
            const config = { ...partial, codec };
            const { supported, slow } = await probeSingleAudio(config);
            if (supported) {
                result[name] = { supported, slow, codec };
                break;
            }
        }
    }

    return result;
}

export async function probeVideo(partial: Omit<VideoEncoderConfig, "codec">) {
    const result: ProbeResult = {};
    for (const [ name, codecs ] of Object.entries(VIDEO_CODECS)) {
        result[name] = { supported: false };
        for (const codec of codecs) {
            const config = { ...partial, codec };
            const { supported, slow } = await probeSingleVideo(config);
            if (supported) {
                result[name] = { supported, slow, codec };
                break;
            }
        }
    }

    return result;
}