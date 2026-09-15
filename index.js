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

// (lastUserText를 캐싱하지 않고 매번 실시간으로 조회함 - 아래 getPendingUserText 참고)

// 이번 생성이 어떤 종류인지(swipe / regenerate / continue / 일반 전송 등)를 기억해둠.
// 스와이프와 "입력 없이 그냥 또 전송(이어쓰기)"은 context.chat 상태가 완전히 똑같아서
// (둘 다 마지막 항목이 AI 응답) 채팅 기록만 봐서는 절대 구분할 수 없음.
// 그래서 생성이 시작될 때 ST가 알려주는 type을 붙잡아둠.
let lastGenerationType = null;

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

// ---------- 지금 이 순간 "주입이 필요한 상태인지" 판단 ----------
// 오늘 겪은 모든 케이스를 관통하는 진짜 기준: context.chat(진짜 채팅 기록)의
// **가장 마지막 항목이 유저 메시지인지, AI 응답인지**만 보면 됨.
//   - 마지막 항목이 유저 메시지 = 그 인풋에 대한 응답을 아직 못 받은 상태
//     (새로 보냄 / 답변 취소 / 답변 삭제 / 재생성 시작 시 기존 응답이 잠깐
//      제거된 상태) -> 주입 필요
//   - 마지막 항목이 AI 응답 = 이미 정상적으로 응답을 받은 상태에서 아무것도
//     안 쓰고 그냥 또 전송(이어쓰기) -> 주입 불필요, 평범하게 진행
// 텍스트를 캐싱해두거나 비교할 필요 없이, 이 순간 chat 배열의 맨 끝 항목의
// 역할(role)만 보면 되므로 편집/삭제/재작성 어떤 경우든 항상 정확함.
function getPendingUserText() {
    try {
        const context = getContext();
        const chat = context.chat;
        if (!Array.isArray(chat) || chat.length === 0) return "";
        const last = chat[chat.length - 1];
        if (last && last.is_user) {
            return (last.mes || "").trim();
        }

        // --- 여기부터 추가: 스와이프 / 재생성 대응 ---
        // 스와이프(다시 굴리기)를 누르면 그 AI 응답은 "버리고 새로 만드는" 것이므로,
        // 사실상 직전 유저 인풋에 대한 답을 다시 받는 상황임. 즉 일반 전송과 똑같이
        // 유저 인풋이 맨 밑에 있어야 함.
        // 그런데 이 순간 context.chat의 마지막 항목은 (아직 지워지지 않은) AI 응답이라
        // 위의 is_user 검사에 걸리지 않아서, 지금까지 스와이프 때만 기능이 통째로
        // 빠져있었음.
        //
        // ⚠️ 단, 배열을 끝까지 거슬러 올라가며 유저 메시지를 찾으면 안 됨.
        // 예: 그리팅 -> 유저 인풋 -> AI응답1 -> AI응답2 상태에서 AI응답2를 스와이프하면,
        // 이미 AI응답1로 답변이 끝난 옛날 인풋을 끌어와서 엉뚱하게 주입해버림.
        // 올바른 기준은 "스와이프 대상 바로 앞 메시지가 유저 메시지인가" 하나뿐임.
        //   - 유저 인풋 -> AI응답 (이 AI응답 스와이프)  = 그 인풋에 대한 답 -> 주입 O
        //   - AI응답1 -> AI응답2 (이 AI응답2 스와이프)  = 이어쓰기의 재생성  -> 주입 X
        //
        // ⚠️ "입력 없이 그냥 또 전송(이어쓰기)"도 마지막 항목이 AI 응답이라 상태가
        // 완전히 동일함. 그건 기존처럼 주입하지 않아야 하므로, 채팅 기록이 아니라
        // 생성 타입으로만 구분함.
        if (isRerollType(lastGenerationType) && chat.length >= 2) {
            const prev = chat[chat.length - 2];
            if (prev && prev.is_user) {
                return (prev.mes || "").trim();
            }
        }

        return ""; // 마지막이 AI 응답이면 = 이미 답변 받은 상태 -> 주입 안 함
    } catch (e) {
        console.error("[Force Last Input Plus] 유저 메시지 조회 실패:", e);
        return "";
    }
}

// 스와이프/재생성 계열인지 판별. ST 버전마다 타입 문자열이 조금씩 다를 수 있어서
// 정확히 일치시키지 않고 키워드 포함 여부로 느슨하게 확인함.
function isRerollType(type) {
    if (!type || typeof type !== "string") return false;
    const t = type.toLowerCase();
    return t.includes("swipe") || t.includes("regenerate");
}

// ---------- 프롬프트 맨 끝으로 강제 재배치 ----------

function isForceEnabled(rawText) {
    return !!getConfig().enabled && !!rawText;
}

function wrapUserInput(text) {
    const tag = (getConfig().wrapTag || DEFAULT_CONFIG.wrapTag).trim() || DEFAULT_CONFIG.wrapTag;
    return `<${tag}>\n${text}\n</${tag}>`;
}

// 공백류(스페이스/탭/줄바꿈 연속)를 전부 한 칸으로 합치고 앞뒤 trim.
// 유저가 실제로 입력한 텍스트와 eventData.chat 안에 들어있는 텍스트가
// 개행 방식/트레일링 스페이스 등 사소한 포맷 차이로 어긋나는 경우를 흡수하기 위함.
function normalize(text) {
    return String(text).replace(/\s+/g, " ").trim();
}

// 핵심 로직:
// role만 보고 "마지막 user 항목"을 잡으면, 백엔드(Gemini 프롬프트 빌더 등)가
// 프롬프트 구조를 닫기 위해 끼워넣는 더미 user 턴(예: </chat_log></engine_prompt>
// 같은 것)을 진짜 유저 입력으로 착각해서 엉뚱한 걸 잡아버리는 문제가 있었음.
//
// 그래서 "내용 매칭" 기반으로, 방금 실시간으로 읽어온 rawText(=지금 이 순간
// context.chat의 진짜 마지막 유저 메시지)와 정규화 후 비교해서 찾음. 더미
// 항목은 유저가 실제로 친 텍스트를 담고 있을 리가 없으니 이 매칭에 절대
// 걸리지 않음. 배열 끝에서부터 검색해서 가장 마지막에 나오는 매칭 항목을
// 잡으므로, 같은 문장이 과거에도 있었더라도 항상 최신 발화 위치를 정확히 찾음.
// 실제 context.chat(채팅 로그)은 전혀 건드리지 않고, eventData.chat(이번
// 생성에만 쓰이는 임시 배열)만 조작 -> 화면/저장 데이터에는 영향 없음.
function findMatchingIndex(chatArray, rawText) {
    const target = normalize(rawText);
    if (!target) return -1;

    for (let i = chatArray.length - 1; i >= 0; i--) {
        const entry = chatArray[i];
        if (entry && entry.role === "user" && typeof entry.content === "string") {
            const normalizedContent = normalize(entry.content);
            if (normalizedContent === target || normalizedContent.includes(target)) {
                return i;
            }
        }
    }
    return -1;
}

// Chat Completion (Gemini/Vertex, Claude API, OpenAI 등)
function onChatCompletionPromptReady(eventData) {
    try {
        if (!eventData || eventData.dryRun) return;

        const rawText = getPendingUserText();
        if (!isForceEnabled(rawText)) return;
        if (!Array.isArray(eventData.chat)) return;

        const chat = eventData.chat;
        const targetIndex = findMatchingIndex(chat, rawText);
        if (targetIndex === -1) {
            console.warn("[Force Last Input Plus] 일치하는 유저 입력을 찾지 못해 관여하지 않음");
            return;
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
// 위치 기반으로 "마지막 user 항목"을 찾을 방법이 없음. 여기서도 캐싱된 값
// 대신 매번 실시간으로 조회한 텍스트를 사용함.
function onTextCompletionPromptReady(eventData) {
    try {
        if (!eventData) return;

        const rawText = getPendingUserText();
        if (!isForceEnabled(rawText)) return;
        if (typeof eventData.prompt !== "string") return;

        const payload = wrapUserInput(rawText);

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
    // 생성이 시작될 때 그 종류(swipe / continue / regenerate / normal 등)를 붙잡아둠.
    // 프롬프트가 만들어지는 시점에는 이 정보를 알 수 없어서 미리 저장해둬야 함.
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, (type) => {
            lastGenerationType = typeof type === "string" ? type : null;
        });
    } else {
        console.warn("[Force Last Input Plus] GENERATION_STARTED 이벤트를 찾을 수 없음 (스와이프 대응 비활성)");
    }

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

    refreshPanelStatus();
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
            <div class="inline-drawer-content flip-root">

                <div class="flip-head">
                    <span class="flip-head-name">입력 강제 최하단 삽입</span>
                    <span id="flip-status-badge" class="flip-badge">OFF</span>
                </div>

                <div class="flip-row">
                    <span class="flip-label">아이콘<small>켜짐 / 꺼짐</small></span>
                    <div class="flip-ctl">
                        <input id="flip-on-emoji-input" class="text_pole flip-mini" type="text" maxlength="10" value="${config.onEmoji}" title="켜짐(ON) 아이콘">
                        <input id="flip-off-emoji-input" class="text_pole flip-mini" type="text" maxlength="10" value="${config.offEmoji}" title="꺼짐(OFF) 아이콘">
                    </div>
                </div>

                <div class="flip-row">
                    <span class="flip-label">크기 · 여백<small>px</small></span>
                    <div class="flip-ctl">
                        <input id="flip-icon-size-input" class="text_pole flip-mini" type="number" min="12" max="64" step="1" value="${config.iconSize}" title="아이콘 크기">
                        <input id="flip-icon-margin-input" class="text_pole flip-mini" type="number" min="0" max="40" step="1" value="${config.iconMarginRight}" title="오른쪽 여백">
                    </div>
                </div>

                <div class="flip-row">
                    <span class="flip-label">감싸는 태그</span>
                    <input id="flip-wrap-tag-input" class="text_pole flip-tag" type="text" maxlength="60" value="${config.wrapTag}">
                </div>

                <div id="flip-tag-preview" class="flip-preview"></div>

                <details class="flip-help">
                    <summary>사용법</summary>
                    <p>보내는 메시지를 프롬프트 <b>맨 아래</b>에 한 번 더 넣어 AI가 놓치지 않게 합니다. 버튼은 전송 버튼 왼쪽에 있어요.</p>
                    <p>새 입력 없이 이어지는 생성(재생성·스와이프·이어쓰기)에서는 중복 삽입 없이 자연스럽게 넘어갑니다.</p>
                </details>

            </div>
        </div>
    </div>
    `;

    const $target = $("#extensions_settings2").length ? $("#extensions_settings2") : $("#extensions_settings");
    $target.append(html);

    refreshPanelStatus();

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
        refreshPanelStatus();
    });
}

// 설정 패널의 상태 뱃지와 주입 미리보기를 현재 설정에 맞춰 갱신
function refreshPanelStatus() {
    const config = getConfig();

    const $badge = $("#flip-status-badge");
    if ($badge.length) {
        $badge.text(config.enabled ? "ON" : "OFF").toggleClass("flip-badge-on", !!config.enabled);
    }

    const $preview = $("#flip-tag-preview");
    if ($preview.length) {
        const tag = config.wrapTag || DEFAULT_CONFIG.wrapTag;
        $preview.text(`<${tag}>보내는 메시지<\/${tag}>`);
    }
}

// ---------- 초기화 ----------

jQuery(async () => {
    buildToggleButton();
    buildSettingsPanel();
    registerHooks();
});
