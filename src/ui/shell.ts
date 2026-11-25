export const shell = `
  <canvas id="dock" aria-label="Трёхмерная сцена Нижних доков"></canvas>
  <div id="battle-input" aria-hidden="true" hidden>
    <div id="stick" hidden><span id="stick-knob"></span></div>
  </div>

  <header id="hud" class="hud" hidden>
    <div class="health hud-pane">
      <div class="health-line"><span class="health-name">Данил</span><span><strong id="player-hp">100</strong><span class="health-max"> / 100</span></span></div>
      <progress id="player-health" max="100" value="100" aria-label="Здоровье Данила"></progress>
    </div>
    <div class="objective hud-pane">
      <span id="chapter" class="label">Сухой док</span>
      <strong id="objective">Дойди до боевой зоны</strong>
    </div>
    <button id="pause" class="pause hud-pane" data-action="pause" type="button" aria-label="Пауза" title="Пауза">
      <span aria-hidden="true"></span>
    </button>
    <div id="enemy-health" class="enemy-health hud-pane" hidden>
      <span id="enemy-name">Доковый сторож</span><strong id="enemy-hp">54</strong>
      <progress id="enemy-bar" aria-label="Здоровье противника" value="54" max="54"></progress>
      <span id="boss-mark" class="boss-mark" aria-hidden="true" hidden></span>
    </div>
    <div id="boarding" class="boarding hud-pane" hidden>
      <div>Посадка <strong id="boarding-time">0 / 26 с</strong></div>
      <progress id="boarding-bar" aria-label="Прогресс посадки" value="0" max="26"></progress>
      <div id="intrusion" class="intrusion" hidden>Вторжение <strong id="intrusion-time">0 / 8 с</strong></div>
    </div>
  </header>

  <div id="hit-feedback" class="hit-feedback" aria-live="polite" hidden></div>

  <section id="coaching" class="coaching" hidden aria-label="Подсказка">
    <strong id="tip-title"></strong><span id="tip-detail"></span>
  </section>

  <section id="drill-options" class="drill-options hud-pane" aria-label="Тренировка опоры" hidden>
    <div class="drill-copy" aria-live="polite">
      <strong id="drill-result">Куда уйдёт вес сторожа?</strong>
      <span id="drill-measurement">Один боковой удар · две постановки стоп</span>
    </div>
    <div class="drill-buttons">
      <button class="button secondary" data-action="planted" type="button" aria-pressed="true">Устойчивая стойка</button>
      <button class="button secondary" data-action="transfer" type="button" aria-pressed="false">Перенос веса</button>
    </div>
  </section>

  <section id="menu" class="menu" data-screen="menu" aria-labelledby="title" hidden>
    <div class="menu-content">
      <div class="location label"><span></span> Нижний порт</div>
      <h1 id="title">Противовес</h1>
      <p>Возьми аварийный резак и освободи путь к эвакуационной платформе.</p>
      <div class="menu-actions">
        <button class="button primary" data-action="start" type="button"><span id="menu-start">Начать дуэль</span><span id="menu-mission" class="action-note">Сухой док</span></button>
        <div class="menu-subactions">
          <button class="button secondary" data-action="campaign" type="button">Кампания</button>
          <button class="button secondary" data-action="training" type="button">Тренировка опоры</button>
        </div>
        <button class="button quiet" data-action="controls" type="button">Управление</button>
      </div>
    </div>
  </section>

  <section class="overlay" data-screen="campaign" hidden>
    <div class="panel campaign-panel" aria-labelledby="campaign-title">
      <h2 id="campaign-title">Нижние доки</h2>
      <div id="mission-list" class="mission-list"></div>
      <button class="button quiet" data-action="menu" type="button">В главное меню</button>
    </div>
  </section>

  <section class="overlay" data-screen="prepare" hidden>
    <div class="panel campaign-panel" aria-labelledby="prepare-title">
      <span class="label">Нижние доки</span>
      <h2 id="prepare-title"></h2>
      <p id="prepare-summary"></p>
      <div class="loadout">
        <label for="weapon">Оружие</label>
        <select id="weapon">
          <option value="W1">Аварийный резак</option>
          <option value="W2">Короткий тесак</option>
        </select>
        <p id="weapon-description"></p>
        <label for="difficulty">Сложность</label>
        <select id="difficulty">
          <option value="story">История</option>
          <option value="normal">Обычная</option>
          <option value="master">Мастер</option>
        </select>
      </div>
      <ul id="prepare-stars" class="result-stars"></ul>
      <div class="panel-actions">
        <button class="button primary" data-action="launch" type="button">Начать миссию</button>
        <button class="button quiet" data-action="campaign" type="button">Назад к карте</button>
      </div>
    </div>
  </section>

  <section class="briefing" data-screen="intro" hidden aria-label="Сообщение Льва">
    <div class="briefing-card">
      <span class="label">Лев · связь с платформой</span>
      <p>Платформа у сухого дока. Выведи нас на верхний пролёт.</p>
      <button class="button secondary" data-action="skip" type="button">Пропустить</button>
    </div>
  </section>

  <section class="overlay" data-screen="pause" hidden>
    <div class="panel" role="dialog" aria-modal="true" aria-labelledby="pause-title">
      <span id="pause-location" class="label">Сухой док</span>
      <h2 id="pause-title">Пауза</h2>
      <div class="panel-actions">
        <button class="button primary" data-action="resume" type="button">Продолжить</button>
        <button class="button secondary" data-action="repeat" type="button">Повторить</button>
        <button class="button secondary" data-action="controls" type="button">Управление</button>
      </div>
      <div class="settings">
        <label><input id="sound" type="checkbox" checked> Боевые звуки</label>
        <label><input id="motion" type="checkbox"> Сниженная динамика</label>
      </div>
      <button id="pause-exit" class="button quiet" data-action="leave" type="button">К карте</button>
    </div>
  </section>

  <section class="overlay" data-screen="leave" hidden>
    <div class="panel" role="dialog" aria-modal="true" aria-labelledby="leave-title">
      <h2 id="leave-title">Вернуться к карте?</h2>
      <p>Текущая попытка завершится.</p>
      <div class="panel-actions">
        <button class="button primary" data-action="keep-playing" type="button">Остаться в бою</button>
        <button class="button secondary" data-action="campaign" type="button">К карте</button>
      </div>
    </div>
  </section>

  <section class="overlay" data-screen="controls" hidden>
    <div class="panel" role="dialog" aria-modal="true" aria-labelledby="controls-title">
      <h2 id="controls-title">Управление</h2>
      <dl class="controls-list">
        <div><dt>Шаг</dt><dd>Проведи пальцем в нижней половине экрана. На клавиатуре — WASD или стрелки.</dd></div>
        <div><dt>Удар</dt><dd>Разгонись и быстро смени направление движения примерно на четверть оборота.</dd></div>
        <div><dt>Стойка</dt><dd>Отпусти стик или нажми пробел после шага. Короткое окно позволяет парировать встречный клинок.</dd></div>
      </dl>
      <button class="button primary" data-action="back" type="button">Готово</button>
    </div>
  </section>

  <section class="overlay" data-screen="result" hidden>
    <div class="panel result" role="dialog" aria-modal="true" aria-labelledby="result-title">
      <span id="result-mission" class="label">Сухой док</span>
      <h2 id="result-title"></h2>
      <p id="result-detail"></p>
      <ul id="result-stars" class="result-stars" hidden></ul>
      <div class="panel-actions">
        <button id="result-next" class="button primary" data-action="next" type="button" hidden>Далее</button>
        <button class="button secondary" data-action="repeat" type="button">Повторить</button>
        <button class="button quiet" data-action="campaign" type="button">К карте</button>
      </div>
    </div>
  </section>

  <section class="overlay loading" data-screen="loading" aria-live="polite">
    <div class="panel loading-panel"><span class="loading-mark" aria-hidden="true"></span><p>Загружаем сухой док…</p></div>
  </section>

  <section class="overlay" data-screen="error" hidden>
    <div class="panel" role="dialog" aria-modal="true" aria-labelledby="error-title">
      <h2 id="error-title">Не удалось открыть док</h2>
      <p id="error-message"></p>
      <button class="button primary" data-action="retry" type="button">Повторить загрузку</button>
    </div>
  </section>

  <div id="save-message" class="save-message" role="status" hidden></div>
  <pre id="diagnostics" hidden></pre>
`;

export const tips = [
  ['Проведи пальцем', 'Шагай к янтарной границе. На клавиатуре — WASD или стрелки.'],
  ['Доверни для удара', 'Быстро смени направление во время шага.'],
  ['Отпусти для стойки', 'Отпусти стик или нажми пробел после шага.'],
  ['Ударь на переносе веса', 'Поднятая стопа выдаёт уязвимый момент.'],
] as const;
