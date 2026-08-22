# BBC КП Generator — точный запуск рабочего контура менеджера

Дата фиксации: 2026-08-20  
Релиз-кандидат: `RC-CORR-05`  
Статус: `BUSINESS_APP_REGISTRATION_AND_FINAL_E2E_REQUIRED`

## 1. Что уже готово и повторно не проверяется

- Staging Worker: `bbc-quote-mcp-server-staging`.
- MCP endpoint: `https://bbc-quote-mcp-server-staging.bbchina2023.workers.dev/mcp`.
- Активная Cloudflare version: `10a7a181-3d4b-4904-bbc4-c3202a0aeaf1`.
- Worker release: `1.0.3-rc-corr-05-staging` / `RC-CORR-05`.
- Backend: Apps Script `4.2.1`, contour `1.0.5-rc-corr-03`.
- Автоматические тесты: 34 PASS, 0 FAIL.
- OAuth discovery, DCR и прямой redirect в GitHub подтверждены.
- Production не изменялся.

Старое приложение `BBC КП Generator — E2E DEV-016.40 STAGING DCR` не обновлять и не переподключать. Оно хранит старый снимок из четырёх MCP-инструментов. Для ChatGPT Business изменение набора инструментов опубликованного приложения требует создания нового приложения.

## 2. Создать одно новое приложение для финальной приёмки

Создавать в workspace `Big Business China`, а не в личном workspace `BBC Free`.

Параметры:

- Название: `BBC КП Generator — FINAL RC-CORR-05`.
- Описание: `Финальная приёмка контура формирования КП BIG BUSINESS CHINA из Canonical Deal и VERIFIED Snapshot v2.`
- Server URL: `https://bbc-quote-mcp-server-staging.bbchina2023.workers.dev/mcp`.
- Authentication: `OAuth`.
- Client registration: `Dynamic Client Registration (DCR)`.
- Default OAuth scopes: `quote.read`, `quote.write`, `quote.generate`.

В фактически показанном интерфейсе ChatGPT Business отдельная кнопка `Scan Tools` в форме создания может отсутствовать. После создания черновика:

1. Открыть карточку нового draft.
2. Если карточка показывает кнопку `Включить`, нажать её. Это делает приложение доступным для подключения, но само по себе не доказывает загрузку tools.
3. Если OAuth откроется сразу, завершить его. Если OAuth не открылся, открыть пользовательские `Настройки → Приложения`, найти новый draft с меткой `Dev`, выбрать подключение и завершить OAuth там.
4. Открыть новый чат, выбрать только новый draft и проверить его фактическую tool surface.

Приёмка допустима только если подключённое приложение предоставляет ровно пять действий:

1. `validateCanonicalDeal`
2. `recalculateDeal`
3. `getVerifiedSnapshot`
4. `generateQuote`
5. `getDealStatus`

Если видны `startDealFromFiles`, `submitManagerAnswers`, старый `generateQuote(dealId)` или `getDealPackage`, это не новый контур. Такое приложение не публиковать и не использовать.

## 3. Единственный финальный E2E

Контрольная сделка: `BBC-15af9054-0cfd-414e-b0c9-90a50ac6d2a6`.

Не создавать новую сделку, не импортировать файлы повторно и не запускать повторный расчёт. В новом чате с выбранным только приложением `BBC КП Generator — FINAL RC-CORR-05` выполнить:

1. `getDealStatus` для контрольной сделки.
2. `getVerifiedSnapshot` по `snapshotId` последнего VERIFIED Snapshot v2 из шага 1, с `includePayload=true`.
3. `generateQuote` по этому `snapshotId`, с новым стабильным `idempotencyKey` и `outputProfile=FULL_MASTER_WORKBOOK`.
4. Повторить только `generateQuote` с тем же `idempotencyKey` и подтвердить отсутствие дублей.

PASS допускается только при одновременном выполнении условий:

- `quoteContextSource = SNAPSHOT_V2`;
- `rawImportReadsAfterSnapshot = 0`;
- `recalculationAfterSnapshot = false`;
- `outputProfile = FULL_MASTER_WORKBOOK`;
- возвращены и открываются Google Sheets, XLSX и PDF;
- повтор с тем же idempotency key возвращает тот же authoritative результат без новых документов;
- финансовые значения совпадают с VERIFIED Snapshot v2;
- в КП нет пробела, `—`, `Согласуется`, placeholder или default там, где значение есть в актуальном исходнике или подтверждено менеджером.

## 4. После PASS — без нового аудита

1. Зафиксировать ответы вызовов, URL документов и время E2E.
2. Записать фактически развёрнутые Apps Script deployment/version и Cloudflare version.
3. Сохранить точный source, lockfile и release manifests в Git commit/tag.
4. Обновить `RELEASE_C_FINAL_REPORT.md` до `READY_TO_CLOSE_PROJECT`.
5. Выполнить контролируемое продвижение именно проверенного RC-CORR-05 в production.
6. Создать новое финальное Business-приложение, направленное на production MCP endpoint, и убедиться, что оно показывает те же пять действий.
7. Создать отдельный ChatGPT Project менеджера `BBC — Создание коммерческих предложений` и подключить только финальное production-приложение.

## 5. Инструкция нового Project менеджера

В инструкции Project вставить следующий текст:

> Ты — рабочий ассистент менеджера BIG BUSINESS CHINA по созданию коммерческих предложений. Пользователь передаёт документы новой сделки. Сначала извлеки все доступные данные из актуальных исходных файлов. Никогда не спрашивай то, что уже есть в исходниках, Canonical Deal, VERIFIED Snapshot или ранее подтверждено менеджером. Если обязательный бизнес-параметр действительно отсутствует либо актуальные источники противоречат друг другу, задай один точный вопрос и дождись ответа. Не заменяй известное значение пробелом, `—`, `Согласуется`, placeholder или default. Курсы валют являются параметрами конкретной сделки и даты: бери их только из актуального источника сделки или из ответа менеджера; не переноси курс из другой сделки. После получения всех обязательных данных сформируй Canonical Deal, проверь его через `validateCanonicalDeal`, создай VERIFIED Snapshot v2 через `recalculateDeal`, затем сформируй КП через `generateQuote`. Финальное КП создавай только из VERIFIED Snapshot v2. После выполнения дай менеджеру краткий итог и рабочие ссылки на Google Sheets, XLSX и PDF. Не показывай менеджеру Cloudflare, GitHub, Apps Script, MCP, идентификаторы развертываний и другую инженерную информацию.

## 6. Граница завершения

Проект считается завершённым только когда:

- финальный E2E имеет PASS;
- проверенный релиз продвинут в production;
- создано новое production-приложение с пятью действиями;
- создан отдельный менеджерский ChatGPT Project;
- в этом Project успешно сформировано одно КП через production-контур;
- release source и deployment IDs зафиксированы.

До этого честный статус: `NOT_READY_FOR_MANAGER_WORK`.
