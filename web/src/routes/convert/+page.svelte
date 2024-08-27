<script lang="ts">
    import LibAVWrapper from "$lib/libav/encode";
    import { t } from "$lib/i18n/translations";
    import stringify from "json-stringify-pretty-compact";

    import DropReceiver from "$components/misc/DropReceiver.svelte";
    import FileReceiver from "$components/misc/FileReceiver.svelte";
    import type { StreamInfo } from "$lib/types/libav";
    import { onDestroy } from "svelte";

    let file: File | undefined;
    let streamInfo: StreamInfo[] | undefined;

    const ff = new LibAVWrapper();
    ff.init();

    const render = async () => {
        if (!file) return;
        await ff.init();
        await ff.cleanup();
        await ff.feed(file);
        await ff.prep();
        streamInfo = await ff.getStreamInfo();
        console.log(streamInfo);

        for (const stream_index in streamInfo) {
            const stream = streamInfo[stream_index];
            if (!stream.supported) continue;

            const maybe_codec = Object.values(stream.output).find(a => a.supported && !a.slow);
            if (maybe_codec && maybe_codec.supported) {
                const decoderConfig = await ff.streamIndexToConfig(+stream_index);
                const config = {
                    ...decoderConfig,
                    width: 'codedWidth' in decoderConfig ? decoderConfig.codedWidth : undefined,
                    height: 'codedHeight' in decoderConfig ? decoderConfig.codedHeight : undefined,
                    codec: maybe_codec.codec
                };

                await ff.configureEncoder(+stream_index, config);
            } else {
                await ff.configureEncoder(+stream_index, 'passthrough');
            }
        }

        const blob = new Blob(
            [ await ff.work('mp4') ],
            { type: 'video/mp4' }
        );
        console.log('she=onika ate=burgers blob=', blob);

        const pseudolink = document.createElement("a");
        pseudolink.href = URL.createObjectURL(blob);
        pseudolink.download = "video.mp4";
        pseudolink.click();
    };

    onDestroy(async () => {
        await ff.cleanup();
        ff.shutdown();
    });

    $: if (file) {
        render();
    }
</script>

<DropReceiver id="remux-container" bind:file>
    <div id="remux-open">
        <FileReceiver
            bind:file
            acceptTypes={["video/*", "audio/*", "image/*"]}
            acceptExtensions={[
                "mp4",
                "webm",
                "mp3",
                "ogg",
                "opus",
                "wav",
                "m4a",
            ]}
        />
        <div class="subtext remux-description">
            {$t("remux.description")}
        </div>
    </div>
    {#if streamInfo}
        <div class="codec-info">
            i am (hopefully) working. check console
            { stringify(streamInfo) }
        </div>
    {/if}
</DropReceiver>

<style>
    :global(#remux-container) {
        display: flex;
        justify-content: center;
        align-items: center;
        width: 100%;
    }

    #remux-open {
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        max-width: 450px;
        text-align: center;
        gap: 32px;
        transition: transform 0.2s, opacity 0.2s;
    }

    .remux-description {
        font-size: 14px;
        line-height: 1.5;
    }

    .codec-info {
        white-space: pre;
        font-family: 'Comic Sans MS', cursive;
        color: red;
    }
</style>
