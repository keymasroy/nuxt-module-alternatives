import type { RefreshableScheme, SchemePartialOptions, SchemeCheck, RefreshableSchemeOptions, UserOptions, SchemeOptions, HTTPResponse, EndpointsOption, TokenableSchemeOptions } from '../../types';
import type { IncomingMessage } from 'http'
import type { Auth } from '../core';
import { encodeQuery, getProp, normalizePath, parseQuery, removeTokenPrefix, urlJoin, randomString } from '../../utils';
import { RefreshController, RequestHandler, ExpiredAuthSessionError, Token, RefreshToken } from '../inc';
import { BaseScheme } from './base';
import { useRoute, useRuntimeConfig } from '#imports';
import requrl from 'requrl';

export interface Oauth2SchemeEndpoints extends EndpointsOption {
    authorization: string;
    token: string;
    userInfo: string;
    logout: string | false;
}

export interface Oauth2SchemeOptions extends SchemeOptions, TokenableSchemeOptions, RefreshableSchemeOptions {
    endpoints: Oauth2SchemeEndpoints;
    user: UserOptions;
    responseMode: 'query.jwt' | 'fragment.jwt' | 'form_post.jwt' | 'jwt';
    responseType: 'code' | 'token' | 'id_token' | 'none' | string;
    grantType: 'implicit' | 'authorization_code' | 'client_credentials' | 'password' | 'refresh_token' | 'urn:ietf:params:oauth:grant-type:device_code';
    accessType: 'online' | 'offline';
    redirectUri: string;
    logoutRedirectUri: string;
    clientId: string;
    clientSecretTransport: 'body' | 'aurthorization_header';
    scope: string | string[];
    state: string;
    codeChallengeMethod: 'implicit' | 'S256' | 'plain';
    acrValues: string;
    audience: string;
    autoLogout: boolean;
    clientWindow: boolean;
    clientWindowWidth: number;
    clientWindowHeight: number;
    organization?: string;
}

const DEFAULTS: SchemePartialOptions<Oauth2SchemeOptions> = {
    name: 'oauth2',
    accessType: undefined,
    redirectUri: undefined,
    logoutRedirectUri: undefined,
    clientId: undefined,
    clientSecretTransport: 'body',
    audience: undefined,
    grantType: undefined,
    responseMode: undefined,
    acrValues: undefined,
    autoLogout: false,
    endpoints: {
        logout: undefined,
        authorization: undefined,
        token: undefined,
        userInfo: undefined,
    },
    scope: [],
    token: {
        property: 'access_token',
        type: 'Bearer',
        name: 'Authorization',
        maxAge: 1800,
        global: true,
        prefix: '_token.',
        expirationPrefix: '_token_expiration.',
    },
    refreshToken: {
        property: 'refresh_token',
        maxAge: 60 * 60 * 24 * 30,
        prefix: '_refresh_token.',
        expirationPrefix: '_refresh_token_expiration.',
    },
    user: {
        property: false,
    },
    responseType: 'token',
    codeChallengeMethod: 'implicit',
    clientWindow: false,
    clientWindowWidth: 400,
    clientWindowHeight: 600
};

export class Oauth2Scheme<OptionsT extends Oauth2SchemeOptions = Oauth2SchemeOptions> extends BaseScheme<OptionsT> implements RefreshableScheme {
    req: IncomingMessage | undefined;
    token: Token;
    refreshToken: RefreshToken;
    refreshController: RefreshController;
    requestHandler: RequestHandler;
    #clientWindowReference: Window | undefined | null

    constructor($auth: Auth, options: SchemePartialOptions<Oauth2SchemeOptions>, ...defaults: SchemePartialOptions<Oauth2SchemeOptions>[]) {
        super($auth, options as OptionsT, ...(defaults as OptionsT[]), DEFAULTS as OptionsT);

        this.req = process.server ? $auth.ctx.ssrContext!.event.req : undefined;

        // Initialize Token instance
        this.token = new Token(this, this.$auth.$storage);

        // Initialize Refresh Token instance
        this.refreshToken = new RefreshToken(this, this.$auth.$storage);

        // Initialize Refresh Controller
        this.refreshController = new RefreshController(this);

        // Initialize Request Handler
        this.requestHandler = new RequestHandler(this, this.$auth.ctx.$http);
    }

    protected get scope(): string {
        return Array.isArray(this.options.scope) ? this.options.scope.join(' ') : this.options.scope;
    }

    protected get redirectURI(): string {
        const basePath = useRuntimeConfig().app.baseURL || '';
        const path = normalizePath(basePath + '/' + this.$auth.options.redirect.callback); // Don't pass in context since we want the base path
        return this.options.redirectUri || urlJoin(requrl(this.req), path);
    }

    protected get logoutRedirectURI(): string {
        return (this.options.logoutRedirectUri || urlJoin(requrl(this.req), this.$auth.options.redirect.logout));
    }

    check(checkStatus = false): SchemeCheck {
        const response = {
            valid: false,
            tokenExpired: false,
            refreshTokenExpired: false,
            isRefreshable: true,
        };

        // Sync tokens
        const token = this.token.sync();
        this.refreshToken.sync();

        // Token is required but not available
        if (!token) {
            return response;
        }

        // Check status wasn't enabled, let it pass
        if (!checkStatus) {
            response.valid = true;
            return response;
        }

        // Get status
        const tokenStatus = this.token.status();
        const refreshTokenStatus = this.refreshToken.status();

        // Refresh token has expired. There is no way to refresh. Force reset.
        if (refreshTokenStatus.expired()) {
            response.refreshTokenExpired = true;
            return response;
        }

        // Token has expired, Force reset.
        if (tokenStatus.expired()) {
            response.tokenExpired = true;
            return response;
        }

        response.valid = true;
        return response;
    }

    async mounted(): Promise<HTTPResponse | void> {
        const { tokenExpired, refreshTokenExpired } = this.check(true);

        // Force reset if refresh token has expired
        // Or if `autoLogout` is enabled and token has expired
        if (refreshTokenExpired || (tokenExpired && this.options.autoLogout)) {
            this.$auth.reset();
        }

        // Initialize request interceptor
        this.requestHandler.initializeRequestInterceptor(
            this.options.endpoints.token
        );

        // Handle callbacks on page load
        const redirected = await this.#handleCallback();

        if (!redirected) {
            return this.$auth.fetchUserOnce();
        }
    }

    reset(): void {
        this.$auth.setUser(false);
        this.token.reset();
        this.refreshToken.reset();
        this.requestHandler.reset();
    }

    async login($opts: { state?: string; params?: any; nonce?: string } = {}): Promise<void> {

        const opts = {
            protocol: 'oauth2',
            response_type: this.options.responseType,
            access_type: this.options.accessType,
            client_id: this.options.clientId,
            redirect_uri: this.redirectURI,
            scope: this.scope,
            // Note: The primary reason for using the state parameter is to mitigate CSRF attacks.
            // https://auth0.com/docs/protocols/oauth2/oauth-state
            state: $opts.state || randomString(10),
            code_challenge_method: this.options.codeChallengeMethod,
            clientWindow: this.options.clientWindow,
            clientWindowWidth: this.options.clientWindowWidth,
            clientWindowHeight: this.options.clientWindowHeight,
            ...$opts.params,
        };

        if (this.options.organization) {
            opts.organization = this.options.organization;
        }

        if (this.options.audience) {
            opts.audience = this.options.audience;
        }

        // Set Nonce Value if response_type contains id_token to mitigate Replay Attacks
        // More Info: https://openid.net/specs/openid-connect-core-1_0.html#NonceNotes
        // More Info: https://tools.ietf.org/html/draft-ietf-oauth-v2-threatmodel-06#section-4.6.2
        // Keycloak uses nonce for token as well, so support that too
        // https://github.com/nuxt-community/auth-module/pull/709
        if (opts.response_type.includes('token') || opts.response_type.includes('id_token')) {
            opts.nonce = $opts.nonce || randomString(10);
        }

        if (opts.code_challenge_method) {
            switch (opts.code_challenge_method) {
                case 'plain':
                case 'S256':
                    {
                        const state = this.generateRandomString();
                        this.$auth.$storage.setUniversal(this.name + '.pkce_state', state);
                        const codeVerifier = this.generateRandomString();
                        this.$auth.$storage.setUniversal(this.name + '.pkce_code_verifier', codeVerifier);
                        const codeChallenge = await this.pkceChallengeFromVerifier(codeVerifier, opts.code_challenge_method === 'S256');
                        opts.code_challenge = window.encodeURIComponent(codeChallenge);
                    }
                    break;
                case 'implicit':
                default:
                    break;
            }
        }

        if (this.options.responseMode) {
            opts.response_mode = this.options.responseMode;
        }

        if (this.options.acrValues) {
            opts.acr_values = this.options.acrValues;
        }

        this.$auth.$storage.setUniversal(this.name + '.state', opts.state);

        const url = this.options.endpoints.authorization + '?' + encodeQuery(opts);

        if (opts.clientWindow) {
            if (this.#clientWindowReference === null || this.#clientWindowReference!.closed) {
                // Window features to center popup in middle of parent window
                const windowFeatures = this.clientWindowFeatures(window, opts.clientWindowWidth, opts.clientWindowHeight)

                this.#clientWindowReference = window.open(url, 'oauth2-client-window', windowFeatures)

                let strategy = this.$auth.$state.strategy

                let listener = this.clientWindowCallback.bind(this)

                // setting listener to know about approval from oauth provider
                window.addEventListener('message', listener)

                // watching pop up window and clearing listener when it closes
                // or is being used by a different provider
                let checkPopUpInterval = setInterval(() => {
                    if (this.#clientWindowReference!.closed || strategy !== this.$auth.$state.strategy) {
                        window.removeEventListener('message', listener)
                        this.#clientWindowReference = null
                        clearInterval(checkPopUpInterval)
                    }
                }, 500)
            } else {
                this.#clientWindowReference!.focus()
            }
        } else {
            window.location.replace(url)
        }
    }

    clientWindowCallback(event: MessageEvent): void {
        const isLogInSuccessful: boolean = !!event.data.isLoggedIn
        if (isLogInSuccessful) {
            this.$auth.fetchUserOnce()
        }
    }

    clientWindowFeatures(window: Window, clientWindowWidth: number, clientWindowHeight: number): string {
        const top = window.top!.outerHeight / 2 + window.top!.screenY - clientWindowHeight / 2
        const left = window.top!.outerWidth / 2 + window.top!.screenX - clientWindowWidth / 2
        return `toolbar=no, menubar=no, width=${clientWindowWidth}, height=${clientWindowHeight}, top=${top}, left=${left}`
    }

    logout(): void {
        if (this.options.endpoints.logout) {
            const opts = {
                client_id: this.options.clientId,
                redirect_uri: this.logoutRedirectURI
            };
            const url = this.options.endpoints.logout + '?' + encodeQuery(opts);
            window.location.replace(url);
        }
        return this.$auth.reset();
    }

    async fetchUser(): Promise<void> {
        if (!this.check().valid) {
            return;
        }

        if (!this.options.endpoints.userInfo) {
            this.$auth.setUser({});
            return;
        }

        const response = await this.$auth.requestWith({
            url: this.options.endpoints.userInfo,
        });

        this.$auth.setUser(getProp(response, this.options.user.property!));
    }

    async #handleCallback(): Promise<boolean | void> {
        const route = useRoute();
        // Handle callback only for specified route
        if (this.$auth.options.redirect && normalizePath(route.path) !== normalizePath(this.$auth.options.redirect.callback)) {
            return;
        }
        // Callback flow is not supported in server side
        if (process.server) {
            return;
        }

        const hash = parseQuery(route.hash.slice(1));
        const parsedQuery = Object.assign({}, route.query, hash);
        // accessToken/idToken
        let token: string = parsedQuery[this.options.token!.property] as string;
        // refresh token
        let refreshToken: string;

        if (this.options.refreshToken.property) {
            refreshToken = parsedQuery[this.options.refreshToken.property] as string;
        }

        // Validate state
        const state = this.$auth.$storage.getUniversal(this.name + '.state');
        this.$auth.$storage.setUniversal(this.name + '.state', null);
        if (state && parsedQuery.state !== state) {
            return;
        }

        // -- Authorization Code Grant --
        if (this.options.responseType === 'code' && parsedQuery.code) {
            let codeVerifier: any;

            // Retrieve code verifier and remove it from storage
            if (this.options.codeChallengeMethod && this.options.codeChallengeMethod !== 'implicit') {
                codeVerifier = this.$auth.$storage.getUniversal(this.name + '.pkce_code_verifier');
                this.$auth.$storage.setUniversal(this.name + '.pkce_code_verifier', null);
            }

            const response = await this.$auth.request({
                method: 'post',
                url: this.options.endpoints.token,
                baseURL: '',
                body: new URLSearchParams({
                    code: parsedQuery.code as string,
                    client_id: this.options.clientId as string,
                    redirect_uri: this.redirectURI,
                    response_type: this.options.responseType,
                    audience: this.options.audience,
                    grant_type: this.options.grantType,
                    code_verifier: codeVerifier,
                }).toString(),
            });

            token = (getProp(response, this.options.token!.property) as string) || token;
            refreshToken = (getProp(response, this.options.refreshToken.property) as string) || refreshToken!;
        }

        if (!token || !token.length) {
            return;
        }

        // Set token
        this.token.set(token);

        // Store refresh token
        if (refreshToken! && refreshToken.length) {
            this.refreshToken.set(refreshToken);
        }

        if (this.options.clientWindow) {
            if (window.opener) {
                window.opener.postMessage({ isLoggedIn: true })
                window.close()
            }
        }
        // Redirect to home
        else if (this.$auth.options.watchLoggedIn) {
            this.$auth.redirect('home', false);
            return true; // True means a redirect happened
        }
    }

    async refreshTokens(): Promise<HTTPResponse | void> {
        // Get refresh token
        const refreshToken = this.refreshToken.get();

        // Refresh token is required but not available
        if (!refreshToken) {
            return;
        }

        // Get refresh token status
        const refreshTokenStatus = this.refreshToken.status();

        // Refresh token is expired. There is no way to refresh. Force reset.
        if (refreshTokenStatus.expired()) {
            this.$auth.reset();

            throw new ExpiredAuthSessionError();
        }

        // Delete current token from the request header before refreshing
        this.requestHandler.clearHeader();

        const response = await this.$auth.request({
            method: 'post',
            url: this.options.endpoints.token,
            baseURL: '',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                refresh_token: removeTokenPrefix(refreshToken, this.options.token!.type) as string,
                scopes: this.scope,
                client_id: this.options.clientId as string,
                grant_type: 'refresh_token',
            }).toString(),
        })
        .catch((error) => {
            this.$auth.callOnError(error, { method: 'refreshToken' });
            return Promise.reject(error);
        });

        this.updateTokens(response);

        return response;
    }

    protected updateTokens(response: HTTPResponse): void {
        const token = getProp(response, this.options.token!.property) as string;
        const refreshToken = getProp(response, this.options.refreshToken.property) as string;

        this.token.set(token);

        if (refreshToken) {
            this.refreshToken.set(refreshToken);
        }
    }

    protected async pkceChallengeFromVerifier(v: string, hashValue: boolean): Promise<string> {
        if (hashValue) {
            const hashed = await this.#sha256(v);
            return this.#base64UrlEncode(hashed);
        }
        return v; // plain is plain - url-encoded by default
    }

    protected generateRandomString(): string {
        const array = new Uint32Array(28); // this is of minimum required length for servers with PKCE-enabled
        window.crypto.getRandomValues(array);
        return Array.from(array, (dec) => ('0' + dec.toString(16)).slice(-2)).join('');
    }

    #sha256(plain: string): Promise<ArrayBuffer> {
        const encoder = new TextEncoder();
        const data = encoder.encode(plain);
        return window.crypto.subtle.digest('SHA-256', data);
    }

    #base64UrlEncode(str: ArrayBuffer): string {
        // Convert the ArrayBuffer to string using Uint8 array to convert to what btoa accepts.
        // btoa accepts chars only within ascii 0-255 and base64 encodes them.
        // Then convert the base64 encoded to base64url encoded
        // (replace + with -, replace / with _, trim trailing =)
        // @ts-ignore
        return btoa(String.fromCharCode.apply(null, new Uint8Array(str)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }
}