const PQueue = require('p-queue').default;

class MessageQueue {
    constructor() {
        this.queue = new PQueue({
            concurrency: 3, // Send 3 messages simultaneously
            interval: 100, // 100ms interval
            intervalCap: 5 // Max 5 operations per interval
        });
        
        this.queue.on('active', () => {
            console.log(`Working on message. Queue size: ${this.queue.size}`);
        });
    }

    async add(fn) {
        return this.queue.add(fn);
    }

    get size() {
        return this.queue.size;
    }

    async clear() {
        this.queue.clear();
    }
}

module.exports = MessageQueue;