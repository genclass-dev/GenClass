// Local only (not part of the patch): Payload's playwright.config.ts with the preinstalled Chromium of this machine,
// because @playwright/test 1.58.2's own Chromium revision is not installed here, and one worker.
import { devices } from '@playwright/test'

import config from './playwright.config.js'

export default {
  ...config,
  workers: 1,
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // CHROMIUM_PATH: a Chromium binary (here the machine's preinstalled 153); unset, Playwright's own is used
        // GRAVATAR_OFF: no image loads, where www.gravatar.com (the default avatar) is unreachable and its console error
        // would fail every test
        launchOptions: {
          ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
          ...(process.env.GRAVATAR_OFF ? { args: ['--blink-settings=imagesEnabled=false'] } : {}),
        },
      },
    },
  ],
}
