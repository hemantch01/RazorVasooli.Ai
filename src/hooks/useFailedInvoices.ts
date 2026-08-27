import { useQuery } from '@tanstack/react-query';
import type { FailedInvoice, RecoveryStatus } from '../types';

export function useFailedInvoices() {
  return useQuery({
    queryKey: ['failedInvoices'],
    queryFn: async (): Promise<FailedInvoice[]> => {
      const res = await fetch('/api/orchestrator/cases');
      if (!res.ok) {
        throw new Error('Network response was not ok');
      }
      const data = await res.json();
      
      if (data.cases) {
        return data.cases.map((c: any) => {
          let status: RecoveryStatus = 'pending';
          if (c.state === 'RECOVERED') status = 'recovered';
          else if (c.state === 'ESCALATED') status = 'escalated';
          else if (c.state === 'CLOSED_LOST') status = 'failed';
          else if (c.state === 'INTERVENING' || c.state === 'PAUSED_PROMISE') status = 'link_sent';
          else if (c.state === 'DIAGNOSED' || c.state === 'POLICY_SELECTED') status = 'ai_contacted';

          return {
            id: c.id,
            customerName: c.customerName || 'Unknown Customer',
            customerEmail: c.customerEmail || 'N/A',
            amount: c.amount,
            currency: c.currency || 'INR',
            declineCode: c.declineCode || 'INSUFFICIENT_FUNDS',
            status,
            subscriptionId: c.subscriptionId || 'N/A',
            failedAt: c.createdAt,
            retryCount: c.attemptCount || 0,
            channel: c.currentDecision?.channel || 'email',
            lastContactedAt: c.updatedAt
          };
        });
      }
      return [];
    },
    refetchInterval: 5000,
  });
}
