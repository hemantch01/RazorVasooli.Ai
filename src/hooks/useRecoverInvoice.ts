import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FailedInvoice } from '../types';

export function useRecoverInvoice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (inv: FailedInvoice) => {
      const res = await fetch('/api/recovery/create-payment-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: inv.amount,
          customerName: inv.customerName,
          customerEmail: inv.customerEmail,
          discountPercent: 5,
          description: `RazorVasooli AI Dunning for ${inv.id}`,
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to create payment link');
      }

      return res.json();
    },
    onSuccess: () => {
      // Invalidate and refetch
      queryClient.invalidateQueries({ queryKey: ['failedInvoices'] });
    },
  });
}
