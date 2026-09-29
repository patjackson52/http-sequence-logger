import { importFiles } from './model.mjs';

self.onmessage = ({ data }) => {
  try {
    const result = importFiles(data.files, data.limits);
    self.postMessage({ id: data.id, result });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};
