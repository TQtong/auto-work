import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    autoWork: {
      correlationId: string;
      sessionId: string;
      csrfToken: string;
    };
  }
}
