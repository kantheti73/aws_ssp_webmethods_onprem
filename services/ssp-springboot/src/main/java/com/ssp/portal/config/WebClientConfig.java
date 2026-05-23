package com.ssp.portal.config;

import io.netty.channel.ChannelOption;
import io.netty.handler.timeout.ReadTimeoutHandler;
import io.netty.handler.timeout.WriteTimeoutHandler;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.netty.http.client.HttpClient;

import java.util.concurrent.TimeUnit;

/**
 * Pre-configured WebClient pointed at the federated AWS API Gateway.
 *
 * Conservative timeouts because the worst case crosses Direct Connect to webMethods
 * on-prem; we'd rather fail fast and let Resilience4j fall back than hold a thread.
 */
@Configuration
public class WebClientConfig {

    @Value("${ssp.federated-apigw.base-url}")
    private String baseUrl;

    @Value("${ssp.federated-apigw.connect-timeout-ms:2000}")
    private int connectTimeoutMs;

    @Value("${ssp.federated-apigw.read-timeout-ms:5000}")
    private int readTimeoutMs;

    @Bean
    public WebClient federatedApiGwClient() {
        HttpClient httpClient = HttpClient.create()
                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, connectTimeoutMs)
                .responseTimeout(java.time.Duration.ofMillis(readTimeoutMs))
                .doOnConnected(conn -> conn
                        .addHandlerLast(new ReadTimeoutHandler(readTimeoutMs, TimeUnit.MILLISECONDS))
                        .addHandlerLast(new WriteTimeoutHandler(readTimeoutMs, TimeUnit.MILLISECONDS)));

        return WebClient.builder()
                .baseUrl(baseUrl)
                .clientConnector(new ReactorClientHttpConnector(httpClient))
                .build();
    }
}
