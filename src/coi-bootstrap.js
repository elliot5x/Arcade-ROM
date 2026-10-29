const scriptUrl = `${import.meta.env.BASE_URL}coi-serviceworker.min.js`;
const script = document.createElement('script');
script.src = scriptUrl;

const documentWithCurrentScript = document;
const descriptor =
  Object.getOwnPropertyDescriptor(Document.prototype, 'currentScript') ||
  Object.getOwnPropertyDescriptor(documentWithCurrentScript, 'currentScript');

Object.defineProperty(documentWithCurrentScript, 'currentScript', {
  configurable: true,
  get: () => script,
});

const restoreCurrentScript = () => {
  if (descriptor?.get) {
    Object.defineProperty(
      documentWithCurrentScript,
      'currentScript',
      descriptor
    );
  } else {
    delete documentWithCurrentScript.currentScript;
  }
};

script.onload = restoreCurrentScript;
script.onerror = restoreCurrentScript;
document.head.append(script);
