// Сдвигает npm dist-tag `latest` на текущие (только что опубликованные) версии
// публикуемых пакетов workspace'а.
//
// Зачем: в pre-режиме Changesets (`changeset pre enter beta`) `changeset publish`
// кладёт релизы только в `beta`-тег и `latest` НЕ двигает. Без этого шага
// `npm i @monetize.software/sdk` без тега тянул бы старую версию, на которой
// `latest` застрял (исторически — 3.0.0-beta.0). Запускается из `release`-скрипта
// сразу после publish.
//
// Идемпотентен: если `latest` уже указывает на эту версию — no-op. Источник
// версии — локальный package.json (= то, что только что опубликовали).
//
// ВАЖНО: запускать только из актуального checkout'а. Скрипт двигает `latest` на
// ЛОКАЛЬНУЮ версию; на устаревшей ветке это сдвинуло бы `latest` назад. В обычном
// release-флоу (version-packages → release из main) локальная версия — самая
// свежая, так что это безопасно.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkgs = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(root, d.name, 'package.json'))
  .filter((p) => existsSync(p))
  .map((p) => JSON.parse(readFileSync(p, 'utf8')))
  .filter((pkg) => pkg.name?.startsWith('@monetize.software/') && !pkg.private);

if (pkgs.length === 0) {
  console.warn('promote-latest: публикуемых пакетов не найдено — пропускаю.');
  process.exit(0);
}

let failed = false;
for (const { name, version } of pkgs) {
  const spec = `${name}@${version}`;
  try {
    execFileSync('npm', ['dist-tag', 'add', spec, 'latest'], { stdio: 'inherit' });
  } catch {
    failed = true;
    console.error(`promote-latest: не удалось сдвинуть latest на ${spec}`);
  }
}

process.exit(failed ? 1 : 0);
