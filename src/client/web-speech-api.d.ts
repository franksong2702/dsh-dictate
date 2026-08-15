interface WebkitSpeechRecognitionConstructor {
  new (): WebkitSpeechRecognition
}

interface WebkitSpeechRecognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onstart: (() => void) | null
  onresult: ((event: WebkitSpeechRecognitionEvent) => void) | null
  onerror: ((event: WebkitSpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

interface WebkitSpeechRecognitionEvent extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultList
}

interface WebkitSpeechRecognitionErrorEvent extends Event {
  readonly error: string
  readonly message: string
}

interface Window {
  webkitSpeechRecognition?: WebkitSpeechRecognitionConstructor
  SpeechRecognition?: WebkitSpeechRecognitionConstructor
}
