// WhatsApp channel adapter.
// Two modes, both OPTIONAL and never touching a running Hermes gateway:
//   mode 'webhook' : POST JSON to SPECFLOW_WHATSAPP_WEBHOOK_URL (an outbound
//                    relay/Baileys bridge you own). Zero coupling to Hermes.
//   mode 'bridge'  : not auto-started here; point SpecFlow at a Baileys
//                    sidecar via webhook URL. Full-duplex optional.
import { registerChannel } from './router.js';

export function initWhatsAppChannel() {
  registerChannel('whatsapp', {
    summary: () => ({
      mode      : process.env.SPECFLOW_WHATSAPP_MODE || 'disabled',
      webhook   : process.env.SPECFLOW_WHATSAPP_WEBHOOK_URL ? 'configured' : 'none',
    }),
    async send(message) {
      const url = process.env.SPECFLOW_WHATSAPP_WEBHOOK_URL;
      if (!url) {
        throw new Error('SpecFlow WhatsApp webhook not configured (SPECFLOW_WHATSAPP_WEBHOOK_URL)');
      }
      const target = process.env.SPECFLOW_WHATSAPP_TARGET || (process.env.WHATSAPP_HOME_CHANNEL ? `whatsapp:${process.env.WHATSAPP_HOME_CHANNEL}` : 'origin');
      const resp = await fetch(url, {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({ target, message }),
      });
      if (!resp.ok) throw new Error(`webhook returned ${resp.status}`);
    },
  });
}