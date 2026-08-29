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
    return !!getConfig().enabled;
}

function wrapUserInput(text) {
    const tag = (getConfig().wrapTag || DEFAULT_CONFIG.wrapTag).trim() || DEFAULT_CONFIG.wrapTag;
    return `<${tag}>\n${text}\n</${tag}>`;
}

// 핵심 수정 포인트 (텍스트 내용 매칭 완전 폐기):
// 예전 버전들은 전부 "저장해둔 lastUserText와 내용이 일치하는 항목"을 배열에서
// 찾아 제거→재배치하는 방식이었음. 근데 유저 인풋은 아무 태그 없이 다른 프롬프트
// 조각들 사이에 plain 텍스트로 섞여 들어가기 때문에, 완전히 같은 문장이 과거에도
// 있었거나 포맷이 살짝만 달라도 엉뚱한 걸 찾거나 아예 못 찾는 문제가 있었음.
//
// 새 방식: 내용을 저장해뒀다가 비교하는 걸 그만두고, eventData.chat(=이번 생성에
// 실제로 쓰일 배열, 이미 완성된 상태) 안에서 role이 "user"인 항목 중 배열 끝에서
// 가장 가까운 것을 그냥 찾음. 그 배열의 "마지막 user 항목"은 정의상 항상
// "이번 생성 요청이 답해야 할 그 입력"이기 때문에 텍스트 비교 자체가 필요 없음.
//   - 새 인풋을 보낸 경우 → 그 항목이 곧 방금 보낸 텍스트
//   - 이어쓰기/재생성/스와이프처럼 새 입력 없이 다시 생성되는 경우
//     → 그 항목은 여전히 그 이전에 보낸 텍스트 그대로 (자동으로 맞아떨어짐)
// 그 항목의 content를 태그로 감싸고, 혹시 그 뒤에 다른 확장이 뭔가 붙여놨어도
// 상관없이 배열의 진짜 맨 끝으로 옮겨줌.
function findLastUserIndex(chatArray) {
    for (let i = chatArray.length - 1; i >= 0; i--) {
        const entry = chatArray[i];
        if (entry && entry.role === "user" && typeof entry.content === "string") {
            return i;
        }
    }
    return -1;
}

// 이미 감싸진 상태인지 확인 (같은 요청 안에서 이벤트가 여러 번 불려도 이중으로
// 감싸지 않도록 방지)
function isAlreadyWrapped(content, tag) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    return content.trimStart().startsWith(open) && content.trimEnd().endsWith(close);
}

// Chat Completion (Gemini/Vertex, Claude API, OpenAI 등)
function onChatCompletionPromptReady(eventData) {
    try {
        if (!eventData || eventData.dryRun) return;
        if (!isForceEnabled()) return;
        if (!Array.isArray(eventData.chat)) return;

        const chat = eventData.chat;
        const targetIndex = findLastUserIndex(chat);
        if (targetIndex === -1) return; // user 항목이 아예 없으면 관여 안 함

        const tag = (getConfig().wrapTag || DEFAULT_CONFIG.wrapTag).trim() || DEFAULT_CONFIG.wrapTag;
        const target = chat[targetIndex];

        // 원본 텍스트 추출 (이미 감싸진 상태면 안쪽 텍스트만, 아니면 그대로)
        let rawText = target.content;
        if (isAlreadyWrapped(rawText, tag)) {
            rawText = rawText
                .replace(new RegExp(`^\\s*<${tag}>\\s*`), "")
                .replace(new RegExp(`\\s*</${tag}>\\s*$`), "");
        }

        const payload = wrapUserInput(rawText);

        // 배열의 실제 마지막 위치로 옮김 (다른 확장이 뒤에 뭔가 붙여놨어도 무시하고 최하단으로)
        chat.splice(targetIndex, 1);
        chat.push({ role: "user", content: payload });

        console.log(`[Force Last Input Plus] chat-completion 맨 끝으로 강제 재배치됨 (len=${payload.length})`);
    } catch (e) {
        console.error("[Force Last Input Plus] chat-completion 재배치 실패:", e);
    }
}

// Text Completion (KoboldAI, 로컬 모델 등)
// 참고: 문자열 프롬프트는 chat 배열처럼 "역할(role)"이 구분돼 있지 않아서
// 위치 기반으로 "마지막 user 항목"을 찾을 방법이 없음. 이 경로는 어쩔 수 없이
// MESSAGE_SENT에서 캡처해둔 lastUserText(가장 최근 전송된 유저 텍스트)를 그대로 씀.
function onTextCompletionPromptReady(eventData) {
    try {
        if (!eventData) return;
        if (!isForceEnabled() || !lastUserText) return;
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
