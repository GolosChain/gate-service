const core = require('griboyedov');
const stats = core.Stats.client;
const logger = core.Logger;
const BasicService = core.service.Basic;
const Broker = require('./service/Broker');

class Main extends BasicService {
    constructor() {
        super();

        this.addNested(new Broker());
        this.stopOnExit();
    }

    async start() {
        await this.startNested();
        stats.increment('main_service_start');
    }

    async stop() {
        await this.stopNested();
        stats.increment('main_service_stop');
        process.exit(0);
    }
}

new Main().start().then(
    () => {
        logger.info('Main service started!');
    },
    error => {
        logger.error(`Main service failed - ${error}`);
        process.exit(1);
    }
);
