import { installRemoteControl, type AttachPi } from '../src/pi/attach-bridge.js';

/** Load with: pi -e /absolute/path/pi-remote-control/extensions/remote-control.ts */
export default function remoteControl(pi: AttachPi): void {
  installRemoteControl(pi);
}
