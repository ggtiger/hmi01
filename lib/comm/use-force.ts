'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  ForceChannel, ForceChannelState, ForceConnectionEvent, ForceDataEvent,
} from './types';
import { DEFAULT_FORCE_STATE } from './types';
import * as ForceService from './force-service';

export type ForceStates = Record<ForceChannel, ForceChannelState>;

const initialStates: ForceStates = {
  A: { ...DEFAULT_FORCE_STATE },
  B: { ...DEFAULT_FORCE_STATE },
  STEER: { ...DEFAULT_FORCE_STATE },
};

/**
 * 三通道 BLE 力值订阅 Hook
 * - states: 每通道连接状态 + 最新力值 + 会话最大力值
 * - actions: 扫描/连接/断开/清零/校准（统一错误处理）
 */
export function useForce() {
  const [states, setStates] = useState<ForceStates>(initialStates);
  const [error, setError] = useState<string | null>(null);
  /** 每通道最近一条诊断信息（帧解析失败等） */
  const [debugInfo, setDebugInfo] = useState<Partial<Record<ForceChannel, string>>>({});
  const unlistenRefs = useRef<UnlistenFn[]>([]);

  useEffect(() => {
    let mounted = true;

    const setup = async () => {
      try {
        const unlistenData = await listen<ForceDataEvent>('force-data', (event) => {
          if (!mounted) return;
          const { channel, data } = event.payload;
          setStates((prev) => ({
            ...prev,
            [channel]: {
              ...prev[channel],
              latest: data,
              maxN: Math.max(prev[channel].maxN, data.weightN),
            },
          }));
        });

        const unlistenConn = await listen<ForceConnectionEvent>('force-connection-changed', (event) => {
          if (!mounted) return;
          const { channel, state } = event.payload;
          setStates((prev) => ({ ...prev, [channel]: state }));
        });

        const unlistenDebug = await listen<{ channel: ForceChannel; message: string }>(
          'force-debug',
          (event) => {
            if (!mounted) return;
            const { channel, message } = event.payload;
            setDebugInfo((prev) => ({ ...prev, [channel]: message }));
          }
        );

        unlistenRefs.current = [unlistenData, unlistenConn, unlistenDebug];

        // 获取初始全通道状态
        const all = await ForceService.forceGetState().catch(() => null);
        if (mounted && all) {
          setStates((prev) => ({
            A: all['A'] ?? prev.A,
            B: all['B'] ?? prev.B,
            STEER: all['STEER'] ?? prev.STEER,
          }));
        }
      } catch (e) {
        if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) {
          // 浏览器环境静默降级
        } else {
          console.error('[useForce] Setup error:', e);
        }
      }
    };

    setup();

    return () => {
      mounted = false;
      unlistenRefs.current.forEach((fn) => fn());
    };
  }, []);

  const withErrorHandling = useCallback(<T extends (...args: any[]) => Promise<any>>(fn: T) => {
    return (async (...args: Parameters<T>) => {
      try {
        setError(null);
        return await fn(...args);
      } catch (e: any) {
        const msg = typeof e === 'string' ? e : e?.message ?? String(e);
        setError(msg);
        throw new Error(msg);
      }
    }) as T;
  }, []);

  const actions = useMemo(
    () => ({
      scan: withErrorHandling(ForceService.forceScan),
      connect: withErrorHandling(ForceService.forceConnect),
      disconnect: withErrorHandling(ForceService.forceDisconnect),
      zero: withErrorHandling(ForceService.forceZero),
      calibrate: withErrorHandling(ForceService.forceCalibrate),
      resetMax: withErrorHandling(ForceService.forceResetMax),
      clearError: () => setError(null),
    }),
    [withErrorHandling]
  );

  return { states, actions, error, debugInfo };
}
