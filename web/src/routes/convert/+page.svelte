<script lang="ts">
    import LibAVWrapper from "$lib/libav/encode";
    import { t } from "$lib/i18n/translations";

    import DropReceiver from "$components/misc/DropReceiver.svelte";
    import FileReceiver from "$components/misc/FileReceiver.svelte";

    let file: File | undefined;

    const ff = new LibAVWrapper();
    ff.init();

    const render = async () => {
        if (!file) return;
        await ff.init();
        await ff.transcode(file);
    };

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
</style>
