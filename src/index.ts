import { PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';

import { TapoPlatform } from './platform.js';

export { TapoPlatform } from './platform.js';

/**
 * Entry point called by Matterbridge to create the plugin platform.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): TapoPlatform {
  return new TapoPlatform(matterbridge, log, config);
}
