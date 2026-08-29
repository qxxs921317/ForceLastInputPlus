import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

// ⚠️ 다른 확장(Force Last Input 구버전, Aggressive Notepad 등)과 절대 겹치지 않도록
// 이 확장 전용 네임스페이스만 사용합니다. (설정 키 / DOM id 모두 flip- 접두사)
const EXT_NAME = "force-last-input-plus";
const BTN_ID = "flip-toggle-btn";
const ICON_ID = "flip-toggle-icon";

const DEFAULT_CONFIG = {
    enabled: false,
    onEmoji: "🔵",
    offEmoji: "🔴",
    iconSize: 24,
    iconMarginRight: 6,
    wrapTag: "User's Input",
};

let lastUserText = ""; // 가장 최근에 "전송"된 유저 메시지 원문 (계속 유지됨 - 소모/클리어 안 함)

// ---------- 설정 헬퍼 ----------

function getConfig() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = {};
    }
    extension_settings[EXT_NAME] = { ...DEFAULT_CONFIG, ...extension_settings[EXT_NAME] };
    return extension_settings[EXT_NAME];
}

function saveConfig() {
    saveSettingsDebounced();
}

// ---------- 최근 전송된 유저 메시지 캡처 ----------
// MESSAGE_SENT는 유저 메시지가 채팅 배열에 실제로 추가된 직후 발생하므로,
// 여기서 그 시점의 최종 텍스트를 그대로 가져옵니다 (impersonate 등으로 텍스트가
// 바뀌는 경우까지 정확히 반영됨). 새 유저 입력이 들어올 때마다 자동으로 갱신됨.

function captureLastUserMessage() {
    try {
        const context = getContext();
        const chat = context.chat;
        if (!Array.isArray(chat) || chat.length === 0) return;
        const last = chat[chat.length - 1];
        if (last && last.is_user) {
            lastUserText = (last.mes || "").trim();
        }
    } catch (e) {
        console.error("[Force Last Input Plus] 유저 메시지 캡처 실패:", e);
    }
}

// ---------- 프롬프트 맨 끝으로 강제 재배치 ----------

function isForceEnabled() {
    return !!getConfig().enabled && !!lastUserText;
}

function wrapUserInput(text) {
    const tag = (getConfig().wrapTag || DEFAULT_CONFIG.wrapTag).trim() || DEFAULT_CONFIG.wrapTag;
    return `<${tag}>\n${text}\n</${tag}>`;
}

// 핵심 수정 포인트:
// 예전 버전은 "raw 텍스트와 정확히 일치하는 항목"만 찾아서 제거했는데,
// 한 번 감싸서(payload) 맨 끝에 push하고 나면 그 항목의 content는 더 이상
// raw 텍스트와 "정확히 같지" 않고 태그로 감싸진 형태가 됨.
// 그래서 그 다음 생성(이어쓰기/재생성/스와이프 등, 새 유저 입력 없이 다시 생성되는 경우)
// 에서는 기존 항목을 못 찾고 매번 새로 push만 해서 중복이 쌓였음 (구버전 버그의 실제 원인).
//
// 해결: raw 텍스트가 "포함된" user 항목을 찾도록 완화 -> 이전에 감싸서 넣어둔
// 항목도 정확히 찾아서 제거 후 재배치하므로, 몇 번을 다시 호출해도 중복 없이
// 항상 딱 1개만 맨 끝에 존재하게 됨 (idempotent). lastUserText를 강제로 비우는
// "소모" 처리도 하지 않으므로, 이벤트가 한 생성당 여러 번 발생해도 안전함.
function findExistingIndex(chatArray, rawText) {
    for (let i = chatArray.length - 1; i >= 0; i--) {
        const entry = chatArray[i];
        if (
            entry &&
            entry.role === "user" &&
            typeof entry.content === "string" &&
            entry.content.includes(rawText)
        ) {
            return i;
        }
    }
    return -1;
}

// Chat Completion (Gemini/Vertex, Claude API, OpenAI 등)
function onChatCompletionPromptReady(eventData) {
    try {
        if (!eventData || eventData.dryRun) return;
        if (!isForceEnabled()) return;
        if (!Array.isArray(eventData.chat)) return;

        const chat = eventData.chat;
        const payload = wrapUserInput(lastUserText);

        // 기존에 들어가 있던 항목(raw든, 이미 감싸진 형태든)을 정확히 찾아서 제거
        const removeIndex = findExistingIndex(chat, lastUserText);
        if (removeIndex !== -1) {
            chat.splice(removeIndex, 1);
        }

        chat.push({ role: "user", content: payload });
        console.log(`[Force Last Input Plus] chat-completion 맨 끝으로 강제 재배치됨 (len=${payload.length})`);
    } catch (e) {
        console.error("[Force Last Input Plus] chat-completion 재배치 실패:", e);
    }
}

// Text Completion (KoboldAI, 로컬 모델 등)
function onTextCompletionPromptReady(eventData) {
    try {
        if (!eventData) return;
        if (!isForceEnabled()) return;
        if (typeof eventData.prompt !== "string") return;

        const payload = wrapUserInput(lastUserText);

        // 문자열 프롬프트는 정확한 위치 splice가 불가능함.
        // 대신 프롬프트가 이미 이 payload로 끝나 있으면(같은 생성 도중 이벤트가
        // 여러 번 발생한 경우) 다시 붙이지 않고 스킵 -> 중복 방지.
        if (eventData.prompt.trimEnd().endsWith(payload.trim())) {
            return;
        }

        eventData.prompt = `${eventData.prompt}\n${payload}\n`;
        console.log(`[Force Last Input Plus] text-completion 맨 끝에 강제 삽입됨 (len=${payload.length})`);
    } catch (e) {
        console.error("[Force Last Input Plus] text-completion 재배치 실패:", e);
    }
}

function registerHooks() {
    eventSource.on(event_types.MESSAGE_SENT, captureLastUserMessage);

    if (event_types.CHAT_COMPLETION_PROMPT_READY) {
        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
    } else {
        console.warn("[Force Last Input Plus] CHAT_COMPLETION_PROMPT_READY 이벤트를 찾을 수 없음");
    }

    const textEventName = event_types.GENERATE_AFTER_COMBINE_PROMPTS
        || event_types.TEXT_COMPLETION_PROMPT_READY
        || event_types.GENERATE_AFTER_DATA;

    if (textEventName) {
        eventSource.on(textEventName, onTextCompletionPromptReady);
    } else {
        console.warn("[Force Last Input Plus] Text Completion용 이벤트를 찾지 못함");
    }
}

// ---------- 툴바 토글 버튼 ----------

function applyButtonIcon() {
    const config = getConfig();
    $(`#${ICON_ID}`).text(config.enabled ? config.onEmoji : config.offEmoji);
    $(`#${BTN_ID}`)
        .attr("title", config.enabled ? "입력 강제 최하단 삽입: 켜짐" : "입력 강제 최하단 삽입: 꺼짐")
        .toggleClass("flip-active", config.enabled)
        .css({
            width: `${config.iconSize}px`,
            height: `${config.iconSize}px`,
            flex: `0 0 ${config.iconSize}px`,
            fontSize: `${config.iconSize * 0.55}px`,
            marginRight: `${config.iconMarginRight}px`,
        });
}

function buildToggleButton() {
    if ($(`#${BTN_ID}`).length) return; // 중복 삽입 방지

    const html = `<div id="${BTN_ID}" class="interactable" tabindex="0"><span id="${ICON_ID}"></span></div>`;

    const $rightSendForm = $("#rightSendForm");
    if ($rightSendForm.length && $("#send_but").length) {
        $("#send_but").before(html);
    } else {
        // 못 찾으면 잠시 후 재시도 (테마/확장 로딩 순서 이슈 대비)
        setTimeout(buildToggleButton, 500);
        return;
    }

    $(`#${BTN_ID}`).on("click", () => {
        const config = getConfig();
        config.enabled = !config.enabled;
        saveConfig();
        applyButtonIcon();
    });

    applyButtonIcon();
}

// ---------- 확장 설정 패널 (이모지 커스터마이즈) ----------

function buildSettingsPanel() {
    const config = getConfig();

    const html = `
    <div class="flip-settings-block">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🔵 Force Last Input Plus</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label for="flip-on-emoji-input">켜짐(ON) 아이콘</label>
                <input id="flip-on-emoji-input" class="text_pole" type="text" maxlength="10" value="${config.onEmoji}">

                <label for="flip-off-emoji-input">꺼짐(OFF) 아이콘</label>
                <input id="flip-off-emoji-input" class="text_pole" type="text" maxlength="10" value="${config.offEmoji}">

                <label for="flip-icon-size-input">아이콘 크기 (px)</label>
                <input id="flip-icon-size-input" class="text_pole" type="number" min="12" max="64" step="1" value="${config.iconSize}">

                <label for="flip-icon-margin-input">오른쪽 여백 (px)</label>
                <input id="flip-icon-margin-input" class="text_pole" type="number" min="0" max="40" step="1" value="${config.iconMarginRight}">

                <label for="flip-wrap-tag-input">감싸는 태그 이름 (&lt;태그&gt;내용&lt;/태그&gt;)</label>
                <input id="flip-wrap-tag-input" class="text_pole" type="text" maxlength="60" value="${config.wrapTag}">

                <small>💡 보내는 메시지가 맨 밑에 강제로 들어가서 AI가 절대 놓치지 않게 하는 기능이에요. 새 입력 없이 이어지는 생성(재생성/스와이프 등)에서는 중복 삽입 없이 자연스럽게 이어져요. 버튼은 전송 버튼 옆에 있어요.</small>
            </div>
        </div>
    </div>
    `;

    const $target = $("#extensions_settings2").length ? $("#extensions_settings2") : $("#extensions_settings");
    $target.append(html);

    $("#flip-on-emoji-input").on("input", function () {
        const val = $(this).val().trim() || DEFAULT_CONFIG.onEmoji;
        getConfig().onEmoji = val;
        saveConfig();
        applyButtonIcon();
    });

    $("#flip-off-emoji-input").on("input", function () {
        const val = $(this).val().trim() || DEFAULT_CONFIG.offEmoji;
        getConfig().offEmoji = val;
        saveConfig();
        applyButtonIcon();
    });

    $("#flip-icon-size-input").on("input", function () {
        let val = parseInt($(this).val(), 10);
        if (isNaN(val)) return;
        val = Math.min(64, Math.max(12, val));
        getConfig().iconSize = val;
        saveConfig();
        applyButtonIcon();
    });

    $("#flip-icon-margin-input").on("input", function () {
        let val = parseInt($(this).val(), 10);
        if (isNaN(val)) return;
        val = Math.min(40, Math.max(0, val));
        getConfig().iconMarginRight = val;
        saveConfig();
        applyButtonIcon();
    });

    $("#flip-wrap-tag-input").on("input", function () {
        const val = $(this).val().trim() || DEFAULT_CONFIG.wrapTag;
        getConfig().wrapTag = val;
        saveConfig();
    });
}

// ---------- 초기화 ----------

jQuery(async () => {
    buildToggleButton();
    buildSettingsPanel();
    registerHooks();
});
