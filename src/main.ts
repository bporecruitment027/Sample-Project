import { installMainThreadPrivacyGuards } from './privacy/networkGuard.ts';
import { PrivateTranscriberAppController } from './ui/appController.ts';

// Install strict runtime privacy & network guards before any application component mounts
installMainThreadPrivacyGuards(globalThis);

const controller = new PrivateTranscriberAppController();
void controller.initialize();
