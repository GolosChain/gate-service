const core = require('gls-core-service');
const InnerGate = core.services.Connector;
const BasicMain = core.services.BasicMain;
const env = require('./env');
const Broker = require('./service/Broker');
const FrontendGate = require('./service/FrontendGate');

class Main extends BasicMain {
    constructor() {
        super(env);
        this.addNested(new Broker(InnerGate, FrontendGate));
    }
}

module.exports = Main;
