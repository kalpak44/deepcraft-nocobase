import { Plugin, Application } from '@nocobase/client-v2';

export class PluginNocoTranscribeClient extends Plugin<any, Application> {
  async load() {
    // No blocks/models to register — this plugin only exposes a server-side
    // AI tool + REST resource. Kept for package-structure consistency.
  }
}

export default PluginNocoTranscribeClient;
