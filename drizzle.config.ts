import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/storage/schema.ts',
  out: './drizzle',
});
