# P0–P1: исходные сборки, состояние и регрессии

2026-10-02. Основание: `main` на `0acee41`. Это результаты подготовительных этапов
[плана](snapshots-hardforks-plan.md), а не объявление поддержки снапшотов или переходов. Проверки
выполнены с Deno 2.9.7 на `linux/arm64` в Docker. Исходные логи и данные сетей находятся в ignored
`.cache/p0-p1/` и `.panda/`; публичный отчёт не содержит локальных checkout paths.

Машиночитаемые результаты: [reports/snapshots/p0-p1.json](../reports/snapshots/p0-p1.json).
`deno task check` прошёл; обычный suite: **109 passed, 0 failed, 13 ignored**. Основной реальный E2E
прошёл на обеих чистых EL-композициях до slot 129 / finalized epoch 2 с проверкой EL/CL agreement.
Это отдельные проверки, а не полный `test:profile`.

## Что действительно сломано

Gloas теряет PTC-голоса при штатной остановке BN. Проверка выполняет одинаковые три слота в двух
сетях с одинаковым genesis и bake. Первая продолжает работу, вторая сохраняет данные клиентов,
останавливает и пересоздаёт их на тех же часах. Следующий блок сравнивается вместе с подписями,
aggregation bits и state root.

- BN/VC restart при работающем EL: **FAIL**. В блоке 4 вместо 512 PTC-позиций — пустой список.
- EL/BN/VC restart: **FAIL**, такое же отличие.
- Блок перед остановкой совпадает; после рестарта EL/CL согласованы, блок 4 построен. Поэтому
  проверка только доступности RPC или роста номера блока пропустила бы потерю.
- Единственное отличие в body блока 4 — `payload_attestations`; следствие — другой state root.
- Pectra прошла оба сравнения: следующий блок совпал целиком. Это результат конкретной точки
  остановки, а не сертификация универсального восстановления Pectra.

Нативный тест на точном Gloas Lighthouse воспроизводит причину независимо от Docker lifecycle:
обычная gossip-проверка принимает настоящие BLS-сообщения, агрегат покрывает все 512 позиций,
включая повторяющиеся индексы валидаторов, и его подпись проверяется. После production
`PersistedOperationPool::as_store_bytes/from_store_bytes` агрегат пуст. Ошибка возникает именно в
assertion после round-trip, а не при компиляции или создании fixture.

Второй native test прошёл: текущие attestation votes попали в очередь fork choice; операция, которую
state advance timer вызывает на хвосте слота, обработала очередь. FC slot стал `N+1`, хотя protocol
slot ещё `N`. В fixture полные naive attestation votes уже покрыты persistent pool, а sync aggregate
сохраняет 512 позиций после round-trip. Здесь нет основания сохранять все кеши подряд. При неполной
доставке будущий checkpoint обязан проверить покрытие или отказать.

## Почему старые проверки этого не обнаруживали

`bakes/gloas/tests/gloas.ts` проверяет наличие PTC в работающей сети, но не остановку BN и не
round-trip пула. `bakes/shared/tests/lifecycle.ts` проверяет fresh start/down/reset; down удаляет
данные. Fast warp перезапускает VC, оставляя BN и его PTC pool в памяти. Поэтому эти проверки могли
честно проходить одновременно с потерей состояния при холодном restart.

Это пробел покрытия нового требования lossless resume. Он не доказывает поломку непрерывного
выполнения существующих сценариев. Исправление persistence и проверенный parked startup остаются P3;
нынешние красные проверки задают их проверяемый критерий готовности.

## Зафиксированные входы

Полные IDs, digest, платформы, native source hashes и recipes сохранены в immutable manifests:

| Профиль | Исходный bake                                            | Bake для дальнейшей работы с чистым EL               |
| ------- | -------------------------------------------------------- | ---------------------------------------------------- |
| Gloas   | [ci-main-merge](../bakes/gloas/tags/ci-main-merge.json)  | [p0-clean-el](../bakes/gloas/tags/p0-clean-el.json)  |
| Pectra  | [ci-main-merge](../bakes/pectra/tags/ci-main-merge.json) | [p0-clean-el](../bakes/pectra/tags/p0-clean-el.json) |

- Gloas CL: `2d281dfa1b407f7c81cd123954a9fd18ee8f02d2`, upstream 8.2.2.
- Pectra CL: `cfb1f7331064b758c6786e4e1dc15507af5ff5d1`, upstream 7.1.0.
- Gloas исходный EL: `5d8fd6b6082f9aa330dbaf5df52dfcfdb445f186`, Go 1.27.1, `vcs.modified=true`.
  Полный dirty diff из бинарника восстановить нельзя. Собран **новый** EL из этого полного commit
  существующим baker, без дополнительных patches; Go 1.25.14, `vcs.modified=false`. Новый image:
  `sha256:549317edd21bb0e720bf53459e353f4eee30acd3a99a89380f762c0b6cfe0e7e`.
- Pectra исходный EL: `36b2371c59cd91a9b1da062b3e382f05a6d8687e`, Go 1.24.2, `vcs.modified=true`.
  Взята ранее собранная чистая версия того же commit из
  [geth-source](../bakes/pectra/tags/geth-source.json):
  `sha256:3f3d4a82b71796278b66f6f571bc7d3d52616df0a77c79b4c4cc51a5613be70e`. Build metadata повторно
  проверена: `vcs.modified=false`.
- Lighthouse не пересобирался. В новых композициях `source.importedCl` явно указывает прежний image
  ID. Его native provenance берётся из соответствующего `ci-main-merge`, а не выводится из факта
  успешного импорта. Старые manifests/default tags и release workflow не менялись.
- Новые EL композиции пока локальные. Они не опубликованы в registry и не получили статус полного
  `test:profile`; отдельный E2E не заменяет весь release suite.

Gloas genesis image отдельно проверен как набор разных инструментов:

| Часть                                                | Подтверждённый источник                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `generate_genesis.sh`, `defaults.env`, `config.yaml` | byte-for-byte совпадение с source `51fb77af3ad017ab2ae14a6e69246fe95453cdd2`          |
| `eth-genesis-state-generator`                        | Go vcs revision `9bbbf55fa9603b4c2e656fe7c441a340ea61f6d6`, modified=false            |
| Полный image                                         | ID/digest из manifest; source shell не выдаётся за provenance всех вложенных binaries |

Pectra genesis проверен отдельно: shell/defaults/config byte-for-byte совпали с
`f06b98c2cb789c6ac45fd0e6167173820dc095d2`; embedded `eth-beacon-genesis` имеет revision
`f6489518ba1e70bd8b073387119692f264b3b368`, `vcs.modified=false`.

## Полный состав состояния и действия checkpoint

Решения относятся к обоим профилям, если не указано иначе. «Завершить» означает наблюдаемое
подтверждение, а не ожидание произвольного числа миллисекунд. Если подтверждения нет — save
отказывает. Перечень описывает обязательства P2–P5, а не существующие API.

| Состояние                                                                                   | Решение                                                                                              | Проверка перед публикацией checkpoint                                                                                                 |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| EL chaindata, trie/state history, ancients/freezer, snapshots, canonical/finalized pointers | Сохранить весь owned datadir после clean stop                                                        | Реальные head/finalized hashes, chain config и доступность БД после открытия                                                          |
| EL blobpool, sidecars, tx journals и local transaction tracker                              | Сохранить datadir; незавершённые пользовательские tx запрещают save                                  | Нет pending/queued и нет unresolved accepted/unknown submissions; один пустой txpool недостаточен                                     |
| Genesis JSON/SSZ, CL config, fork versions, timing/constants, JWT                           | Сохранить как immutable generation inputs                                                            | Hash каждого входа; те же genesis roots, schedule, chain ID и image IDs                                                               |
| BN hot/cold DB, states/blocks, blob/data-column DB, freezer и split point                   | Сохранить вместе                                                                                     | EL/CL anchors, доступность canonical state и required DA                                                                              |
| Fork choice proto-array, votes, checkpoints, balances и FC store                            | Сохранить                                                                                            | Реальные root и FC slot; protocol slot нельзя использовать вместо FC slot                                                             |
| Fork choice queued attestations                                                             | Достоверно обработать на согласованном tail; иначе отказ/явная persistence                           | Очередь пустая после native completion; проверка должна видеть содержимое, не только clock mark                                       |
| Attestation operation pool                                                                  | Сохранить                                                                                            | SSZ round-trip, требуемые данные/подписи и inclusion следующего блока                                                                 |
| Naive attestation pool                                                                      | Перенести проверенные голоса в persistent pool без выпуска блока либо доказать покрытие; иначе отказ | Для каждого нужного голоса есть соответствующее покрытие; текущий полный tail fixture прошёл                                          |
| Sync contributions в operation pool                                                         | Сохранить                                                                                            | Aggregate data/signature и все committee bits следующего блока                                                                        |
| Naive sync pool                                                                             | Воссоздать из сохранённых verified contributions без новых подписей, только если покрытие доказано   | Частичный набор нельзя объявить полным; иначе сохранить недостающее/отказать                                                          |
| Gloas PTC messages                                                                          | **Добавить persistence в P3**                                                                        | Непустой pool round-trip; следующий блок сохраняет data, signatures и 512 позиций                                                     |
| Voluntary exits, BLS changes, proposer/attester slashings в op_pool                         | Сохранить с native fork/verification metadata                                                        | Pending операции отличать по state от already-included, ещё retained до pruning/finality; missing persisted pool при restore — ошибка |
| Deposits, consolidations, exits, withdrawals уже в consensus state                          | Сохранить в BN DB                                                                                    | Очереди не требуется опустошать; последующая обработка должна совпасть                                                                |
| Pending execution envelopes, DA checker, unverified blocks/payloads и custody work          | Достоверно завершить; иначе отказ                                                                    | Нет незавершённой проверки/import/delivery, canonical payload и DA доступны                                                           |
| Custody context, column assignments, validator registration state                           | Сохранить native durable context                                                                     | Согласованность с genesis/spec и required columns после открытия                                                                      |
| Beacon state/committee/reward caches, prepared skip state, cached duties                    | Воссоздать из проверенного checkpoint                                                                | Без новой подписи, без смещения времени и без притворного completion                                                                  |
| VC keystores, passwords, validator definitions, fee recipients, enabled state               | Сохранить owned directory целиком                                                                    | Совпадает набор ключей/definitions; отсутствующие файлы не заменяются fresh genesis                                                   |
| VC slashing DB, journal/WAL и сохранённая signing history                                   | Сохранить атомарно после остановки                                                                   | DB обязательна, `--init-slashing-protection` на restore запрещён; до/после не исчезли записи                                          |
| VC volatile duty caches и completed-work marks                                              | Воссоздать при parked startup                                                                        | До открытия входа нет повторных/conflicting signatures; отметки не подставляются вручную                                              |
| Controller clock, active generation, session config, lifecycle status                       | Сохранить собственный versioned manifest/journal                                                     | Точный `nowMs`; обе native clocks совпадают; предыдущая незавершённая операция известна                                               |
| Automine/Timeline queue, active RPC, SSE и EL admission intents/results                     | Завершить вход; сохранить durable intents; unknown запрещает create                                  | Нет гонки с save, сохранён исход операции/operation ID; restore доступен из faulted состояния                                         |
| EngineGate pending payload IDs/readiness promises                                           | Завершить; пересоздать gate без in-flight Engine work                                                | Новый gate связан с новым EL, использует реальные лог-события и JWT                                                                   |
| Sockets, host ports, process IDs, file locks, Docker handles                                | Воссоздать                                                                                           | Ownership текущей generation; публичные URL стабильны через managed frontend                                                          |
| Внешние oracle/indexer/provider caches и filters                                            | Вне snapshot; явный reset/reconnect в P9                                                             | Consumer не продолжает отменённую ветку как текущую                                                                                   |
| Неизвестные native operations или неподдерживаемая схема/ABI                                | Запретить save/restore                                                                               | Явная причина вместо потери данных или fresh initialization                                                                           |

## Версии и capabilities

Существующий `Bake.schema=1` не означает snapshot support. Текущий clock ABI определяется namespace
`PANDA`, exact native source hashes и флагами `clockWait/directSync/preparedSkip`. У него нет
checkpoint ACK или parked restore contract.

Для реализации резервируются отдельные `snapshot.schema=1` и `checkpointAbi=1` (wire-протокол,
предложенный в плане), с явным набором native capabilities. Snapshot manifest связывает их с полными
image IDs/platform, bake key, genesis/spec/schedule hashes и inventory. Несовпадение либо
отсутствующая capability — отказ, не попытка «совместимого» восстановления.

| Возможность                                    | Pectra сейчас   | Gloas сейчас              | Условие включения                                       |
| ---------------------------------------------- | --------------- | ------------------------- | ------------------------------------------------------- |
| Обычная controlled сеть                        | Поддерживается  | Поддерживается            | Действующий профильный suite                            |
| Cold next-block equality на исследованном tail | Проверка прошла | Подтверждённая потеря PTC | Это диагностическое наблюдение, не публичная capability |
| Verified checkpoint / parked startup           | Нет             | Нет                       | P2–P3, положительный ACK + read-back + continuation     |
| Snapshot create/restore                        | Нет             | Нет                       | P4–P5, crash/failure и repeat-restore tests             |
| Переход между форками                          | Нет             | Нет                       | P6–P8, active-fork dispatch и реальный crossing suite   |

## Расписание форков и admission

Фактический генератор умеет Electra genesis с Fulu epoch 2 и Gloas epoch 4. Он выдаёт EL timestamps
`2000000768` и `2000001536`; общий префикс genesis SSZ подтверждает slot 0 и Electra fork version.
Однако при его дефолтах `BPO_1_EPOCH=BPO_2_EPOCH=0` Geth отказывает в init:
`unsupported fork ordering: osakaTime enabled at timestamp 2000000768, but bpo1 enabled at timestamp 0`.

Повтор с явными `BPO_1_EPOCH=2`, `BPO_2_EPOCH=3` прошёл. P6 должен компилировать **всё** расписание,
включая BPO, CL blob schedule и EL timestamps; нельзя передать только три fork epochs. Это
исправление входных данных диагностического сценария, не уже реализованный compiler Panda.

Три unit counterexamples существующего controller подтвердили ограничения P7: Gloas family пытается
читать envelope для Electra блока, неверно декодирует pre-Gloas finalized checkpoint и выбирает
Gloas attestation mark даже с таблицей Electra phases. Эти tests изолируют адаптеры; HTTP fixtures
не считаются доказательством совместимости реальных клиентов.

На исходном и чистом Gloas EL исполнен admission scenario:

- Malformed transaction отвергнута и не изменила pool.
- Fee-capped transaction получила hash и осталась без receipt; её нельзя считать rejected.
- Принятая Geth транзакция с оборванной доставкой ответа исполнилась без resend.
- 80 транзакций с nonce gap получили успешные hash-ответы; 16 отсутствовали в `txpool_content`,
  `eth_getTransactionByHash` и receipts после вытеснения из очереди. Следовательно, отсутствие в
  pool не доказывает pre-admission rejection.

Будущий ledger в P2 разрешает доказанный terminal rejection, сохраняет accepted/unknown до
разрешения. Проверка блокировки самого `snapshot.create` появляется вместе с API в P2/P4:
несуществующий API не использован как искусственное доказательство red.

## Как повторить

Для исходных артефактов установить `PANDA_BAKE=ci-main-merge`. Для чистых EL использовать
`PANDA_BAKE=p0-clean-el`. Новые проверки запускаются явно и не меняют длительность release CI.

```sh
deno task check
deno task test
PANDA_PROFILE=pectra PANDA_BAKE=ci-main-merge deno run -A bakes/shared/tests/restart.ts cl
PANDA_PROFILE=pectra PANDA_BAKE=ci-main-merge deno run -A bakes/shared/tests/restart.ts all
PANDA_PROFILE=gloas PANDA_BAKE=ci-main-merge deno run -A bakes/shared/tests/restart.ts cl
PANDA_PROFILE=gloas PANDA_BAKE=ci-main-merge deno run -A bakes/shared/tests/restart.ts all
PANDA_BAKE=ci-main-merge deno run -A bakes/gloas/tests/restart_native.ts
PANDA_BAKE=ci-main-merge deno run -A bakes/gloas/tests/fork_genesis.ts
PANDA_BAKE=ci-main-merge deno run -A bakes/gloas/tests/fork_genesis.ts --aligned-bpo
deno test -A bakes/shared/tests/fork_controller_test.ts
PANDA_PROFILE=gloas PANDA_BAKE=ci-main-merge deno run -A bakes/shared/tests/admission.ts
PANDA_PROFILE=gloas PANDA_BAKE=p0-clean-el deno run -A bakes/shared/tests/admission.ts
PANDA_PROFILE=gloas PANDA_BAKE=p0-clean-el deno run -A bakes/shared/tests/e2e.ts
PANDA_PROFILE=pectra PANDA_BAKE=p0-clean-el deno run -A bakes/shared/tests/e2e.ts
```

На старом Lighthouse Gloas restart/native PTC тесты должны завершаться ошибкой assertion.
`fork_genesis.ts` без BPO overrides должен показать отказ Geth; с `--aligned-bpo` — пройти. Три
controller counterexamples остаются красными до P7. Не заменять проверки на «ожидаемую потерю
данных» ради зелёного suite. После P3/P7 соответствующие контракты должны стать зелёными и войти в
обязательную проверку объявляемой capability.

Нативный runner берёт архивированные patch/clock inputs указанного bake и отдельный текущий
regression test, фиксирует hash каждого источника и использует закреплённый Rust builder.
Изолированное дерево находится под `.cache/`; immutable bake не переписывается. Он собирает test
executable, не новый Lighthouse image.

Это этап получения воспроизводимых failures и проверяемой базы. Lossless resume, долговечный
snapshot, fault recovery, сохранение пользовательских CL операций, fork crossing и комбинации с
oracle ещё не реализованы и не объявлены проверенными.
