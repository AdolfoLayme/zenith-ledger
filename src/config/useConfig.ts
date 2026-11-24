import { useEffect, useState } from 'react';
import { DEFAULT_CONFIG, loadConfig, type AppConfig } from './index';
import { fetchRemoteValues } from './remote';

/** Starts with the built-in defaults and swaps in Remote Config values when they arrive. */
export function useConfig(useRemote: boolean): AppConfig {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  useEffect(() => {
    if (useRemote) loadConfig(fetchRemoteValues).then(setConfig);
  }, [useRemote]);
  return config;
}
