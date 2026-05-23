'use client'

import React from 'react'

interface Props {
  children:  React.ReactNode
  fallback?: React.ReactNode
  // Optional label shown in the fallback for easier debugging
  name?:     string
}

interface State { hasError: boolean }

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep a console trace without crashing anything
    console.error(`[ErrorBoundary${this.props.name ? ` · ${this.props.name}` : ''}]`, error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="flex items-center justify-center w-full h-full min-h-[80px]
          text-gray-600 text-[12px] select-none">
          Something went wrong — please refresh.
        </div>
      )
    }
    return this.props.children
  }
}
