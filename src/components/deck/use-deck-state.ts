"use client";

// deck 工作台数据轮询：2.5s 一次，带去重锁（在飞请求不并发），页面隐藏时暂停。
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError } from "@/lib/client/api";
import { getCreditBalance, getDeckState, type DeckState } from "@/lib/client/deck-api";

const POLL_INTERVAL = 2500;

export function useDeckState(deckId: string) {
  const [state, setState] = useState<DeckState | null>(null);
  const [fatalError, setFatalError] = useState<ApiClientError | null>(null);
  const inFlightRef = useRef(false);
  const stoppedRef = useRef(false);

  const refresh = useCallback(async () => {
    // 去重锁：上一个请求未回来则不并发
    if (inFlightRef.current || stoppedRef.current) return;
    inFlightRef.current = true;
    try {
      const next = await getDeckState(deckId);
      if (!stoppedRef.current) {
        setState(next);
        setFatalError(null);
      }
    } catch (error) {
      if (stoppedRef.current) return;
      // 401/403/404 为终态错误，停轮询；其余（网络抖动/5xx）下轮自动重试
      if (error instanceof ApiClientError && [401, 403, 404].includes(error.status)) {
        stoppedRef.current = true;
        setFatalError(error);
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [deckId]);

  useEffect(() => {
    stoppedRef.current = false;
    const initialTimer = window.setTimeout(() => {
      void refresh();
    }, 0);
    const timer = window.setInterval(() => {
      if (document.hidden) return; // 页面隐藏时暂停
      void refresh();
    }, POLL_INTERVAL);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stoppedRef.current = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  /** 写操作响应即最新全量状态，直接应用避免等下一轮轮询 */
  const applyState = useCallback((next: DeckState) => {
    setState(next);
  }, []);

  return { state, fatalError, refresh, applyState };
}

/** 顶栏星星余额：监听 anppt:credits-refresh 事件重新拉取 */
export function useCreditBalance() {
  const [balance, setBalance] = useState<number | null>(null);

  const reload = useCallback(async () => {
    const value = await getCreditBalance();
    if (value !== null) setBalance(value);
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => {
      void reload();
    }, 0);
    const handler = () => void reload();
    window.addEventListener("anppt:credits-refresh", handler);
    return () => {
      window.clearTimeout(initialTimer);
      window.removeEventListener("anppt:credits-refresh", handler);
    };
  }, [reload]);

  return balance;
}

export function notifyCreditsRefresh(): void {
  window.dispatchEvent(new Event("anppt:credits-refresh"));
}
