import { Plugin, Application } from '@nocobase/client-v2';
import MsConnectBlockModel from './models/MsConnectBlockModel';

export class PluginMsConnectorClient extends Plugin<any, Application> {
  async load() {
    this.flowEngine.registerModelLoaders({
      MsConnectBlockModel: {
        loader: () => Promise.resolve({ default: MsConnectBlockModel }),
      },
    });
  }
}

export default PluginMsConnectorClient;
