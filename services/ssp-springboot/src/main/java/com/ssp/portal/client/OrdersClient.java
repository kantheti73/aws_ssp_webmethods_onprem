package com.ssp.portal.client;

import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.github.resilience4j.retry.annotation.Retry;
import io.github.resilience4j.bulkhead.annotation.Bulkhead;
import io.github.resilience4j.timelimiter.annotation.TimeLimiter;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletionStage;

/**
 * Calls /onprem/orders/{id} through the federated AWS API Gateway, which
 * in turn proxies via VPC Link → webMethods → on-prem orders service.
 *
 * Every resilience policy is *named* so it can be tuned in application.yml
 * without redeploying.
 */
@Component
public class OrdersClient {

    private final WebClient client;

    public OrdersClient(@Qualifier("federatedApiGwClient") WebClient client) {
        this.client = client;
    }

    @CircuitBreaker(name = "onpremOrders", fallbackMethod = "fallbackGetOrder")
    @Retry(name = "onpremOrders")
    @Bulkhead(name = "onpremOrders", type = Bulkhead.Type.THREADPOOL)
    @TimeLimiter(name = "onpremOrders")
    public CompletionStage<Map<String, Object>> getOrder(String orderId, String bearerToken, String traceparent) {
        return client.get()
                .uri("/onprem/orders/{id}", orderId)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + bearerToken)
                .header("traceparent", traceparent)
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .retrieve()
                .bodyToMono(new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() {})
                .toFuture();
    }

    /**
     * Fallback returns a degraded payload rather than failing the whole page.
     * The SSP UI shows a "limited mode" badge when this fires.
     */
    @SuppressWarnings("unused")
    private CompletionStage<Map<String, Object>> fallbackGetOrder(String orderId, String bearerToken,
                                                                   String traceparent, Throwable t) {
        return Mono.just(Map.<String, Object>of(
                "orderId", orderId,
                "degraded", true,
                "reason", t.getClass().getSimpleName()
        )).toFuture();
    }
}
