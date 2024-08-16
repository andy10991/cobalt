import Queue from 'yocto-queue';

export class BufferStream<T> extends ReadableStream<T> {
    queue = new Queue<T | null>();
    res?: () => void;

    constructor() {
        super({
            pull: async (controller) => {
                while (!this.queue.size) {
                    await new Promise<void>(res => this.res = res);
                }
                const next = this.queue.dequeue();
                if (next !== null)
                    controller.enqueue(next);
                else
                    controller.close();
            }
        });

    }

    push(next: T | null) {
        this.queue.enqueue(next);

        if (this.res) {
            const res = this.res;
            this.res = undefined;
            res();
        }
    }
}
