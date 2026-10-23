import { Container, getContainer } from '@cloudflare/containers';

export class AgarGame extends Container {
  defaultPort = 3000;
  sleepAfter = '30m';
}

export default {
  fetch(request, env) {
    return getContainer(env.AGAR_GAME, 'event-1024-apac-diag').fetch(request);
  },
};
