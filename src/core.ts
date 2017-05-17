import { checkApi } from "./apicheck";
import compress from "./compress";
import { config, script } from "./config";
import { instrument } from "./instrumentation";
import { debug, getCookie, guid, mapProperties, setCookie } from "./utils";

// Constants
const ImpressionAttribute = "data-iid";
const UserAttribute = "data-cid";
const Cookie = "ClarityID";
export const ClarityAttribute = "clarity-iid";

// Variables
let bytes;
let sentBytesCount: number;
let cid: string;
let impressionId: string;
let sequence: number;
let eventCount: number;
let startTime: number;
let components: IComponent[];
let registeredComponents: IComponent[];
let bindings: IBindingContainer;
let droppedPayloads: { [key: number]: IDroppedPayloadInfo };
let timeout: number;
let nextPayload: string[];
let nextPayloadLength: number;
export let state: State = State.Loaded;

export function register(component: IComponent) {
  registeredComponents.push(component);
}

export function activate() {
  if (init()) {
    document[ClarityAttribute] = impressionId;
    for (let component of registeredComponents) {
      component.reset();
      component.activate();
      components.push(component);
    }

    bind(window, "beforeunload", teardown);
    bind(window, "unload", teardown);
    state = State.Activated;
  }
}

export function teardown() {
  for (let component of components) {
    component.teardown();
  }

  // Walk through existing list of bindings and remove them all
  for (let evt in bindings) {
    if (bindings.hasOwnProperty(evt)) {
      let eventBindings = bindings[evt] as IEventBindingPair[];
      for (let i = 0; i < eventBindings.length; i++) {
        (eventBindings[i].target).removeEventListener(evt, eventBindings[i].listener);
      }
    }
  }

  delete document[ClarityAttribute];
  state = State.Unloaded;

  // Upload residual events
  instrument({ type: Instrumentation.Teardown });
  uploadNextPayload();
}

export function bind(target: EventTarget, event: string, listener: EventListener) {
  let eventBindings = bindings[event] || [];
  target.addEventListener(event, listener, false);
  eventBindings.push({
    target,
    listener
  });
  bindings[event] = eventBindings;
}

export function addEvent(type: string, eventState: any, time?: number) {
  let evt: IEvent = {
    id: eventCount++,
    time: typeof time === "number" ? time : getTimestamp(),
    type,
    state: eventState
  };
  let eventStr = JSON.stringify(evt);
  if (nextPayloadLength > 0 && nextPayloadLength + eventStr.length > config.batchLimit) {
    uploadNextPayload();
  }
  nextPayload.push(eventStr);
  nextPayloadLength += eventStr.length;
  if (timeout) {
    clearTimeout(timeout);
  }
  timeout = setTimeout(uploadNextPayload, config.delay);
}

export function getTimestamp(unix?: boolean, raw?: boolean) {
  let time = unix ? getUnixTimestamp() : getPageContextBasedTimestamp();
  return (raw ? time : Math.round(time));
}

function getUnixTimestamp(): number {
  return (window.performance && typeof performance.now === "function")
    ? performance.now() + performance.timing.navigationStart
    : new Date().getTime();
}

// If performance.now function is not available, we do our best to approximate the time since page start
// by using the timestamp from when Clarity script got invoked as a starting point.
// In such case this number may not reflect the 'time since page start' accurately,
// especially if Clarity script is post-loaded or injected after page load.
function getPageContextBasedTimestamp(): number {
  return (window.performance && typeof performance.now === "function")
    ? performance.now()
    : new Date().getTime() - startTime;
}

function envelope(): IEnvelope {
  return {
    clarityId: cid,
    impressionId,
    url: top.location.href,
    version: "0.8",
    time: Math.round(getPageContextBasedTimestamp()),
    sequenceNumber: sequence++
  };
}

function uploadNextPayload() {
  if (nextPayloadLength > 0) {
    let uncompressed = `{"envelope":${JSON.stringify(envelope())},"events":[${nextPayload.join()}]}`;
    let compressed = compress(uncompressed);
    let payload = JSON.stringify(compressed);
    let onSuccess = (status: number) => { mapProperties(droppedPayloads, uploadDroppedPayloadsMappingFunction, true); };
    let onFailure = (status: number) => { onFirstSendDeliveryFailure(status, uncompressed, compressed); };
    upload(payload, onSuccess, onFailure);

    if (config.debug && localStorage) {
      // Debug Information
      bytes.push(compressed);
      let compressedKb = Math.ceil(bytes[bytes.length - 1].length / 1024.0);
      let rawKb = Math.ceil(uncompressed.length / 1024.0);
      debug(`** Clarity #${sequence}: Uploading ${compressedKb}KB (raw: ${rawKb}KB). **`);
      localStorage.setItem("clarity", JSON.stringify(bytes));
    }

    nextPayload = [];
    nextPayloadLength = 0;

    if (state === State.Activated && sentBytesCount > config.totalLimit) {
      let totalByteLimitExceededEventState: ITotalByteLimitExceededEventState = {
        type: Instrumentation.TotalByteLimitExceeded,
        bytes: sentBytesCount
      };
      instrument(totalByteLimitExceededEventState);
      teardown();
    }
  }
}

function uploadDroppedPayloadsMappingFunction(sequenceNumber: string, droppedPayloadInfo: IDroppedPayloadInfo) {
  let onSuccess = (status: number) => { onResendDeliverySuccess(droppedPayloadInfo); };
  let onFailure = (status: number) => { onResendDeliveryFailure(status, droppedPayloadInfo); };
  upload(droppedPayloadInfo.payload, onSuccess, onFailure);
}

function upload(payload: string, onSuccess?: (status: number) => void, onFailure?: (status: number) => void) {
  // Send to the backend
  if (config.uploadUrl.length > 0) {
    let xhr = new XMLHttpRequest();
    xhr.open("POST", config.uploadUrl);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = () => { onXhrReadyStatusChange(xhr, payload.length, onSuccess, onFailure); };
    xhr.send(payload);
  }
  sentBytesCount += payload.length;
}

function onXhrReadyStatusChange(xhr: XMLHttpRequest,
                                bytesSent: number, onSuccess?: (status: number) => void,
                                onFailure?: (status: number) => void) {
  if (xhr.readyState === XMLHttpRequest.DONE) {
    // HTTP response status documentation:
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Status
    if (xhr.status < 200 || xhr.status > 208) {
      sentBytesCount -= bytesSent;
      if (onFailure) {
        onFailure(xhr.status);
      }
    } else {
      if (onSuccess) {
        onSuccess(xhr.status);
      }
    }
  }
}

function onFirstSendDeliveryFailure(status: number, rawPayload: string, compressedPayload: string) {
  let sentObj: IPayload = JSON.parse(rawPayload);
  let xhrErrorEventState: IXhrErrorEventState = {
    type: Instrumentation.XhrError,
    requestStatus: status,
    sequenceNumber: sentObj.envelope.sequenceNumber,
    compressedLength: compressedPayload.length,
    rawLength: rawPayload.length,
    firstEventId: sentObj.events[0].id,
    lastEventId: sentObj.events[sentObj.events.length - 1].id,
    attemptNumber: 0
  };
  droppedPayloads[xhrErrorEventState.sequenceNumber] = {
    payload: compressedPayload,
    xhrErrorState: xhrErrorEventState
  };
  instrument(xhrErrorEventState);
}

function onResendDeliveryFailure(status: number, droppedPayloadInfo: IDroppedPayloadInfo) {
  droppedPayloadInfo.xhrErrorState.requestStatus = status;
  droppedPayloadInfo.xhrErrorState.attemptNumber++;
  instrument(droppedPayloadInfo.xhrErrorState);
}

function onResendDeliverySuccess(droppedPayloadInfo: IDroppedPayloadInfo) {
  delete droppedPayloads[droppedPayloadInfo.xhrErrorState.sequenceNumber];
}

function init() {
  // Reset own state
  bytes = [];
  cid = getCookie(Cookie);
  impressionId = guid();
  sequence = 0;
  eventCount = 0;
  startTime = getUnixTimestamp();
  components = [];
  bindings = {};
  nextPayload = [];
  droppedPayloads = {};
  nextPayloadLength = 0;
  sentBytesCount = 0;

  // If CID cookie isn't present, set it now
  if (!cid) {
    cid = guid();
    setCookie(Cookie, cid);
  }

  // Update identifiers on the script tag to allow for other resources to access it, if required.
  if (script) {
    script.setAttribute(ImpressionAttribute, impressionId);
    script.setAttribute(UserAttribute, cid);
  }

  // Check that no other instance of Clarity is already running on the page
  if (document[ClarityAttribute]) {
    let eventState: IClarityDuplicatedEventState = {
      type: Instrumentation.ClarityDuplicated,
      currentImpressionId: document[ClarityAttribute]
    };
    instrument(eventState);
    teardown();
    return false;
  }

  // If critical API is missing, don't activate Clarity
  if (!checkApi()) {
    teardown();
    return false;
  }

  return true;
}

// Initialize registeredComponents and bindings early, so that registering and wiring up can be done properly
registeredComponents = [];
bindings = {};