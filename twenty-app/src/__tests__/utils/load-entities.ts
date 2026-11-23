import { readdirSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..', '..');

// Imports every `.ts` entity file in a src folder (not utils) and returns
// the config each one's define call validated.
export const loadEntities = async <T = Record<string, unknown>>(
  folder: string,
): Promise<{ file: string; config: T }[]> => {
  const dir = path.join(SRC, folder);
  const files = readdirSync(dir).filter(
    (file) => file.endsWith('.ts') && file !== 'field-factories.ts',
  );

  return Promise.all(
    files.map(async (file) => {
      const module = (await import(path.join(dir, file))) as {
        default: { success: boolean; errors: string[]; config: T };
      };

      if (!module.default.success) {
        throw new Error(`${folder}/${file}: ${module.default.errors.join('; ')}`);
      }

      return { file, config: module.default.config };
    }),
  );
};
