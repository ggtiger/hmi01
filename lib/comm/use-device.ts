'use client';

declare global {
  interface Window {
    __TAURI__?: Record<string, unknown>;
  }
}

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { DebugEvent, DeviceState, LogEntry } from './types';
import { DEFAULT_DEVICE_STATE } from './types';
import * as DeviceService from './device-service';

const MAX_LOG_ENTRIES = 500;

/**
 * 设备订阅 Hook：
 * - state: 最新 DeviceState（含遥测）
 * - events: DEBUG 事件时间线（pedal-event）
 * - debugLog: 通信日志
 * - actions: 全部命令（统一错误处理）
 */
export function useDevice() {
  const [state, setState] = useState<DeviceState>(DEFAULT_DEVICE_STATE);
  const [debugLog, setDebugLog] = useState<LogEntry[]>([]);
  const [lastEvent, setLastEvent] = useState<DebugEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);

  useEffect(() => {
    let mounted = true;

    const setup = async () => {
      try {
        const unlistenState = await listen<DeviceState>('device-state-changed', (event) => {
          if (mounted) setState(event.payload);
        });

        const unlistenLog = await listen<LogEntry>('device-debug-log', (event) => {
          if (mounted) {
            setDebugLog((prev) => {
              const next = [...prev, event.payload];
              return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
            });
          }
        });

        const unlistenEvent = await listen<DebugEvent>('pedal-event', (event) => {
          if (mounted) setLastEvent(event.payload);
        });

        unlistenRefs.current = [unlistenState, unlistenLog, unlistenEvent];

        const initialState = await DeviceService.getState().catch(() => DEFAULT_DEVICE_STATE);
        if (mounted) setState(initialState);
      } catch (e) {
        if (typeof window !== 'undefined' && !window.__TAURI__) {
          console.warn('[useDevice] Not in Tauri environment');
        } else {
          console.error('[useDevice] Setup error:', e);
        }
      }
    };

    setup();

    return () => {
      mounted = false;
      unlistenRefs.current.forEach((fn) => fn());
    };
  }, []);

  // 统一错误处理包装
  const withErrorHandling = useCallback(<T extends (...args: any[]) => Promise<void>>(fn: T) => {
    return (async (...args: Parameters<T>) => {
      try {
        setError(null);
        await fn(...args);
      } catch (e: any) {
        let msg = '操作失败';
        if (typeof e === 'string') {
          msg = e;
        } else if (e?.message) {
          msg = e.message;
        } else if (e?.toString && e.toString() !== '[object Event]') {
          msg = e.toString();
        }
        setError(msg);
        throw new Error(msg);
      }
    }) as T;
  }, []);

  // actions 引用稳定化：避免 20Hz 状态更新导致下游 memo 组件全部失效
  const actions = useMemo(() => {
    const wrap = (fn: (...args: any[]) => Promise<void>) => withErrorHandling(fn);
    return {
      connect: wrap(DeviceService.connect),
      disconnect: wrap(DeviceService.disconnect),
      estop: DeviceService.estop,
      infoGet: DeviceService.infoGet,
      sendRaw: wrap(DeviceService.sendRaw),
      debugSet: wrap(DeviceService.debugSet),
      plainModeSet: wrap(DeviceService.plainModeSet),
      setReport: wrap(DeviceService.setReport),
      setPushPulsesPerMm: wrap(DeviceService.setPushPulsesPerMm),
      setLevelRatio: wrap(DeviceService.setLevelRatio),
      netGetcfg: DeviceService.netGetcfg,
      netSetcfg: wrap(DeviceService.netSetcfg),
      netReset: wrap(DeviceService.netReset),
      pedalSelect: wrap(DeviceService.pedalSelect),
      pedalStart: wrap(DeviceService.pedalStart),
      pedalStop: wrap(DeviceService.pedalStop),
      pedalSetload: wrap(DeviceService.pedalSetload),
      pedalLevel: wrap(DeviceService.pedalLevel),
      pedalPushStart: wrap(DeviceService.pedalPushStart),
      pedalPushStop: wrap(DeviceService.pedalPushStop),
      pedalSet: wrap(DeviceService.pedalSet),
      pedalZero: wrap(DeviceService.pedalZero),
      pedalClear: wrap(DeviceService.pedalClear),
      pedalRecord: wrap(DeviceService.pedalRecord),
      motorEnable: wrap(DeviceService.motorEnable),
      motorDisable: wrap(DeviceService.motorDisable),
      motorStopAll: wrap(DeviceService.motorStopAll),
      motorMove: wrap(DeviceService.motorMove),
      motorMoveabs: wrap(DeviceService.motorMoveabs),
      motorHome: wrap(DeviceService.motorHome),
      motorStop: wrap(DeviceService.motorStop),
      motorZero: wrap(DeviceService.motorZero),
      steerStart: wrap(DeviceService.steerStart),
      steerStop: wrap(DeviceService.steerStop),
      getDebugLog: DeviceService.getDebugLog,
      clearDebugLog: () => setDebugLog([]),
      clearError: () => setError(null),
      clearLastEvent: () => setLastEvent(null),
    };
    // withErrorHandling 依赖为 []，此处仅需初始化一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, actions, debugLog, lastEvent, error };
}
