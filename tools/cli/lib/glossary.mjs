// Mirror of src/lib/glossary.ts DSP_GLOSSARY for Node usage.
export const DSP_GLOSSARY = {
  "discrete-time Fourier transform": "дискретно-временное преобразование Фурье",
  "DTFT": "ДВПФ",
  "inverse DTFT": "обратное ДВПФ",
  "discrete Fourier transform": "дискретное преобразование Фурье",
  "DFT": "ДПФ",
  "inverse DFT": "обратное ДПФ",
  "IDFT": "ОДПФ",
  "fast Fourier transform": "быстрое преобразование Фурье",
  "FFT": "БПФ",
  "z-transform": "z-преобразование",
  "inverse z-transform": "обратное z-преобразование",
  "Laplace transform": "преобразование Лапласа",
  "bilinear transformation": "билинейное преобразование",
  "impulse invariance": "инвариантность импульсной характеристики",
  "FIR": "КИХ",
  "IIR": "БИХ",
  "FIR filter": "КИХ-фильтр",
  "IIR filter": "БИХ-фильтр",
  "lowpass filter": "фильтр нижних частот",
  "highpass filter": "фильтр верхних частот",
  "bandpass filter": "полосовой фильтр",
  "bandstop filter": "режекторный фильтр",
  "allpass filter": "всепропускающий фильтр",
  "comb filter": "гребенчатый фильтр",
  "elliptic filter": "эллиптический фильтр",
  "Butterworth filter": "фильтр Баттерворта",
  "Chebyshev filter": "фильтр Чебышева",
  "Butterworth": "Баттерворт",
  "Chebyshev": "Чебышев",
  "passband": "полоса пропускания",
  "stopband": "полоса задерживания",
  "transition band": "переходная полоса",
  "passband ripple": "пульсации в полосе пропускания",
  "stopband attenuation": "затухание в полосе задерживания",
  "cutoff frequency": "частота среза",
  "ripple": "пульсации",
  "attenuation": "затухание",
  "magnitude response": "амплитудно-частотная характеристика",
  "phase response": "фазо-частотная характеристика",
  "frequency response": "частотная характеристика",
  "amplitude response": "амплитудная характеристика",
  "group delay": "групповая задержка",
  "discrete-time": "дискретно-временной",
  "continuous-time": "непрерывного времени",
  "linear time-invariant": "линейный стационарный",
  "LTI": "ЛСИ",
  "LTI system": "ЛСИ-система",
  "causal sequence": "причинная последовательность",
  "causal system": "причинная система",
  "stable system": "устойчивая система",
  "impulse response": "импульсная характеристика",
  "unit sample response": "отклик на единичный импульс",
  "step response": "переходная характеристика",
  "transfer function": "передаточная функция",
  "difference equation": "разностное уравнение",
  "convolution": "свёртка",
  "linear convolution": "линейная свёртка",
  "circular convolution": "циклическая свёртка",
  "cross-correlation": "взаимная корреляция",
  "autocorrelation": "автокорреляция",
  "sampling": "дискретизация",
  "sampling rate": "частота дискретизации",
  "sampling frequency": "частота дискретизации",
  "sampling period": "период дискретизации",
  "Nyquist": "Найквист",
  "Nyquist frequency": "частота Найквиста",
  "Nyquist rate": "частота Найквиста",
  "Nyquist criterion": "критерий Найквиста",
  "aliasing": "наложение спектров",
  "anti-aliasing": "антиалайсинговый",
  "oversampling": "передискретизация",
  "downsampling": "понижение частоты дискретизации",
  "upsampling": "повышение частоты дискретизации",
  "decimation": "децимация",
  "interpolation": "интерполяция",
  "quantization": "квантование",
  "quantization error": "ошибка квантования",
  "quantization noise": "шум квантования",
  "pole": "полюс",
  "zero": "нуль",
  "pole-zero plot": "карта полюсов и нулей",
  "region of convergence": "область сходимости",
  "ROC": "ОС",
  "magnitude": "модуль",
  "phase": "фаза",
  "spectrum": "спектр",
  "power spectrum": "спектр мощности",
  "window function": "оконная функция",
  "Hamming window": "окно Хэмминга",
  "Hanning window": "окно Хэннинга",
  "Blackman window": "окно Блэкмана",
  "Kaiser window": "окно Кайзера",
  "rectangular window": "прямоугольное окно",
  "signal-to-noise ratio": "отношение сигнал/шум",
  "SNR": "ОСШ",
  "noise": "шум",
  "white noise": "белый шум",
  "Homework": "Домашнее задание",
  "Problem": "Задача",
  "Solution": "Решение",
  "Example": "Пример",
  "Show that": "Покажите, что",
  "Find": "Найдите",
  "Determine": "Определите",
  "Compute": "Вычислите",
  "Prove": "Докажите",
  "Consider": "Рассмотрим",
  "Assume": "Предположим",
  "Note that": "Заметим, что",
  "Hint": "Указание",
};

export function dspGlossaryPrompt(max = 60) {
  const entries = Object.entries(DSP_GLOSSARY).filter(([, ru]) => ru.length > 0);
  const lines = entries.slice(0, max).map(([en, ru]) => `  - ${en} → ${ru}`);
  return [
    "",
    "TERMINOLOGY (use these EXACT Russian equivalents):",
    ...lines,
  ].join("\n");
}

export function applyGlossaryPost(text) {
  if (!text) return text;
  const protectedRe = /(\$\$[\s\S]*?\$\$|\$[^\n$]*?\$|`[^`\n]*`|```[\s\S]*?```)/g;
  const parts = text.split(protectedRe);
  const entries = Object.entries(DSP_GLOSSARY)
    .filter(([, ru]) => ru.length > 0)
    .sort((a, b) => b[0].length - a[0].length);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue;
    let chunk = parts[i];
    for (const [en, ru] of entries) {
      const pat = en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      chunk = chunk.replace(new RegExp(`\\b${pat}\\b`, "gi"), ru);
    }
    parts[i] = chunk;
  }
  return parts.join("");
}
