# Changesets

`@changesets/cli` управляет версионированием и публикацией SDK-пакетов
(`sdk`, `sdk-extension`, `sdk-react`).

## Стандартный flow — обычный (latest) релиз

```bash
# 1. Описать изменения. Интерактивный wizard:
pnpm changeset
#   ? Which packages have changed?
#       — выбрать те, в которых поменялся код
#   ? What kind of change?
#       major | minor | patch
#   ? Summary:
#       — короткая строка для CHANGELOG

# Wizard создаёт файл .changeset/<name>.md с этим решением.
# Файл коммитится вместе с твоими изменениями кода.

# 2. Когда готов релизить:
pnpm release
#   → changeset version    (bump'ит package.json + CHANGELOG)
#   → pnpm -r build        (топологически: sdk → sdk-react/sdk-extension)
#   → changeset publish    (публикует в npm в правильном порядке)
```

Транзитивные пакеты Changesets обновляет сам. Поменял `sdk` → `sdk-react` и
`sdk-extension` автоматом получают patch-bump (см. `updateInternalDependencies`
в `config.json`).

## Alpha-канал

Pre-release режим, версии вида `3.0.0-alpha.5`:

```bash
# 1. Войти в pre-release
pnpm changeset pre enter alpha

# 2. Описывать изменения как обычно
pnpm changeset

# 3. Релизить — всё пойдёт под dist-tag `alpha`
pnpm release

# 4. Когда готов выйти на stable
pnpm changeset pre exit
pnpm release   # следующий релиз будет уже latest
```

Установка для consumer'ов alpha: `pnpm add @monetize.software/sdk@alpha`.

## Что НЕ делает Changesets

- НЕ затрагивает `platform/`, `online/`, `docs/` — они не в workspace
  (см. `pnpm-workspace.yaml`).
- НЕ коммитит сам (commit:false в config) — ты сам решаешь когда коммитить.
- НЕ пушит в git remote — `pnpm release` только npm publish.
